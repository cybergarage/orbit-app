import type { KnowledgeExtractor } from "@cybergarage/orbit";
import type { AcquireSources } from "./source-leases";
import { ProjectKnowledge } from "./project-knowledge";
import { AppInitialization } from "./initialization-host";
import type { InitializationMode } from "./initialization";
import { initializationAvailability } from "./initialization";
import { AutoTitles, generateTitle } from "./auto-titles";
import {
	resolveSchedule,
	nextOccurrence,
	resumeOccurrence,
} from "./scheduling";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store, text, identifier, assertAppProfileRoot } from "./store";
import {
	Worker,
	command,
	dockerPath,
	image,
	verifySessionWriterReleased,
} from "./worker";
import type { Health, Snapshot, Execution, DesktopSession } from "./types";
interface RunControl {
	session: DesktopSession;
	projectId: string;
	sessionId: string;
	requestId: string;
	execution?: Execution;
	rawStatus: string;
	terminal: boolean;
	finished: boolean;
	modelCancelled: boolean;
	independentFailure: boolean;
	cancellation?: { at: string; effective: boolean };
}
function displayedStatus(run: RunControl, settled = false) {
	if (
		!run.cancellation?.effective ||
		run.independentFailure ||
		run.rawStatus === "completed"
	)
		return run.rawStatus;
	if (run.rawStatus === "failed" && !run.modelCancelled) return "failed";
	if (run.terminal && !["failed", "cancelled"].includes(run.rawStatus))
		return run.rawStatus;
	return settled ? "cancelled" : "cancelling";
}
export class Supervisor {
	readonly store: Store;
	readonly titles: AutoTitles;
	readonly knowledge: ProjectKnowledge;
	readonly initialization: AppInitialization;
	private maintenance = false;
	private maintenanceError?: string;
	private maintenanceTask?: Promise<unknown>;
	private storageStopped = false;
	private workerFinished?: Promise<void>;
	worker?: Worker;
	private admitted = false;
	private ticking = false;
	private currentRun?: RunControl;
	private admittingSessionId?: string;
	private epoch = 0;
	private closed = false;
	private recoveryBlocked = false;
	private reconciling?: Promise<void>;
	private saveQueue = Promise.resolve();
	private readonly operations = new Set<Promise<unknown>>();
	constructor(
		root: string,
		private changed: (state: Snapshot) => void,
		private factory = (
			workspace: string,
			core: string,
			config: any,
			event: (e: any) => void,
		) => new Worker(workspace, core, config, event),
		titleGenerator = generateTitle,
		knowledgeOptions: {
			acquire?: AcquireSources;
			extract?: KnowledgeExtractor;
		} = {},
	) {
		this.store = new Store(root);
		this.knowledge = new ProjectKnowledge(
			this.store,
			() =>
				!this.admitted &&
				!this.closed &&
				!this.maintenance &&
				!this.recoveryBlocked &&
				!this.store.state.active,
			knowledgeOptions.acquire,
			knowledgeOptions.extract,
		);
		this.initialization = new AppInitialization(this.store);
		this.titles = new AutoTitles(
			this.store,
			() =>
				!this.admitted &&
				!this.closed &&
				!this.maintenance &&
				!this.recoveryBlocked &&
				!this.store.state.active,
			() => this.publish(),
			titleGenerator,
		);
	}
	async init() {
		await assertAppProfileRoot(this.store.root);
		try {
			const marker = await this.initialization.readMarker();
			if (marker?.phase === "complete")
				await fs.unlink(this.initialization.marker);
			else if (marker) {
				this.maintenance = true;
				this.maintenanceError =
					marker.error ??
					"Initialization was stopped before completion. Review remaining targets while writers stay stopped.";
				await this.store.init(true);
				await this.store.close();
				await this.titles.close();
				await this.knowledge.close();
				this.storageStopped = true;
				this.store.state.maintenance = {
					error: this.maintenanceError,
					complete: false,
				};
				return;
			}
		} catch (error: any) {
			if (error.code !== "ENOENT") throw error;
		}
		await this.store.init();
		await this.reconcile();
		await this.knowledge.init();
		this.knowledge.kick();
	}
	async reconcile() {
		if (this.reconciling) return this.reconciling;
		this.reconciling = this.reconcileOnce().finally(() => {
			this.reconciling = undefined;
		});
		return this.reconciling;
	}
	async reconcileOnce() {
		const a = this.store.state.active;
		if (!a) return;
		this.recoveryBlocked = true;
		try {
			await command(dockerPath, ["info", "--format", "{{.ServerVersion}}"]);
			if (a.containerName) {
				if (!/^orbit-app-[a-f0-9-]{36}$/.test(a.containerName))
					throw new Error("Invalid saved worker identity");
				const containers = await command(dockerPath, [
					"ps",
					"-a",
					"--filter",
					`name=^/${a.containerName}$`,
					"--format",
					"{{.Names}}",
				]);
				if (containers.trim()) {
					const owner = await command(dockerPath, [
						"inspect",
						"--format",
						'{{index .Config.Labels "org.cybergarage.orbit-app.workspace"}}',
						a.containerName,
					]);
					if (
						owner.trim() !==
						this.store.location(a.projectId, a.sessionId).workspace
					)
						throw new Error("Worker ownership mismatch");
					await command(dockerPath, ["rm", "-f", a.containerName]);
				}
			}
			await verifySessionWriterReleased(
				this.store.location(a.projectId, a.sessionId).core,
				a.sessionId,
			);
			this.store.session(a.projectId, a.sessionId).status = "interrupted";
			if (this.store.state.active === a) delete this.store.state.active;
			this.recoveryBlocked = false;
			await this.publish();
		} catch {
			this.store.session(a.projectId, a.sessionId).status = "recovery-blocked";
			await this.publish();
			/* Keep durable identity and block new work until Docker recovers. */
		}
	}
	async publish() {
		if (this.storageStopped)
			throw new Error("App storage is closed for initialization");
		this.store.state.recoveryBlocked = this.recoveryBlocked;
		this.changed(structuredClone(this.store.state));
		this.saveQueue = this.saveQueue.then(() => this.store.save());
		await this.saveQueue;
	}
	async health(): Promise<Health> {
		if (this.maintenance)
			throw new Error("App writers are stopped for initialization");
		if (this.recoveryBlocked) await this.reconcile();
		const health: Health = {
			checkedAt: Date.now(),
			docker: false,
			ollama: false,
			image: false,
			models: [],
			detail: [],
		};
		try {
			await command(dockerPath, ["info", "--format", "{{.ServerVersion}}"]);
			health.docker = true;
			await command(dockerPath, ["image", "inspect", image]);
			health.image = true;
		} catch (e) {
			health.detail.push(String(e));
		}
		try {
			const r = await fetch("http://127.0.0.1:11434/api/tags", {
				signal: AbortSignal.timeout(3000),
			});
			if (!r.ok) throw new Error(`Ollama ${r.status}`);
			const data = await r.json();
			health.ollama = true;
			health.models = data.models
				.filter((m: any) => m.capabilities?.includes("tools"))
				.map((m: any) => m.name);
			if (!health.models.length)
				for (const m of data.models) {
					const show = await fetch("http://127.0.0.1:11434/api/show", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: m.name }),
						signal: AbortSignal.timeout(3000),
					});
					if (show.ok && (await show.json()).capabilities?.includes("tools"))
						health.models.push(m.name);
				}
		} catch (e) {
			health.detail.push(String(e));
		}
		this.store.state.health = health;
		await this.publish();
		return health;
	}
	async submit(p: any, scheduled = false) {
		const execution = this.store.state.executions?.find(
			(r) => r.requestId === p.requestId,
		);
		if (this.closed || this.maintenance)
			throw new Error("App writers are stopped or closing");
		if (this.admitted || this.store.state.active)
			throw new Error("A worker is already active");
		if (this.recoveryBlocked)
			throw new Error("Previous worker recovery is blocked");
		const session = this.store.session(p.projectId, p.sessionId);
		if (session.archived || this.store.project(p.projectId).archived)
			throw new Error(
				"Restore the archived Project or conversation before submitting",
			);
		const prompt = text(p.prompt);
		const model = text(p.model, 120);
		identifier(p.requestId);
		if (
			session.events.some(
				(e) =>
					["submission", "submission-accepted"].includes(e.type) &&
					e.data.requestId === p.requestId,
			)
		)
			throw new Error("Duplicate request");
		this.admitted = true;
		this.admittingSessionId = session.id;
		const epoch = ++this.epoch;
		const run: RunControl = {
			session,
			projectId: p.projectId,
			sessionId: p.sessionId,
			requestId: p.requestId,
			execution,
			rawStatus: "starting",
			terminal: false,
			finished: false,
			modelCancelled: false,
			independentFailure: false,
		};
		this.currentRun = run;
		try {
			const acceptedAt = Date.now();
			if (!scheduled) {
				const sequence = (this.store.state.submissionSequence ?? 0) + 1;
				if (!Number.isSafeInteger(sequence))
					throw new Error("Submission sequence exhausted");
				this.store.state.submissionSequence = sequence;
				session.lastUserSubmission = { at: acceptedAt, sequence };
			}
			session.events.push({
				id: randomUUID(),
				type: "submission-accepted",
				at: new Date(acceptedAt).toISOString(),
				data: {
					requestId: p.requestId,
					origin: scheduled ? "schedule" : "user",
				},
			});
			await this.publish();
			await this.titles.interrupt();
			await this.knowledge.interrupt();
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			await this.titles.provision(p.projectId, session, prompt, model);
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			const health = await this.health();
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			if (this.recoveryBlocked)
				throw new Error(
					"Previous worker recovery is blocked; reconnect Docker first",
				);
			if (!health.docker || !health.ollama || !health.image)
				throw new Error(
					"Docker, worker image, and Ollama must be available. Check health and build the worker image.",
				);
			if (!health.models.includes(model))
				throw new Error("Select an installed tool-capable model");
			const workspace = await this.store.executionWorkspace(
				p.projectId,
				p.sessionId,
			);
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			session.status = "starting";
			session.model = model;
			if (execution) execution.status = "starting";
			session.events.push({
				id: randomUUID(),
				type: "submission",
				at: new Date().toISOString(),
				data: { requestId: p.requestId, prompt, model },
			});
			this.store.state.active = {
				projectId: p.projectId,
				sessionId: p.sessionId,
			};
			await this.publish();
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			const projectContext = await this.knowledge.prepare(
				p.projectId,
				p.sessionId,
				p.requestId,
				prompt,
			);
			if (epoch !== this.epoch || this.closed || this.maintenance)
				throw new Error("Submission cancelled");
			const worker = this.factory(
				workspace,
				this.store.location(p.projectId, p.sessionId).core,
				{
					sessionId: p.sessionId,
					requestId: p.requestId,
					projectContext,
					prompt: this.store.project(p.projectId).instructions
						? `Project guidance (follow applicable workspace ORBIT.md / AGENTS.md instructions):\n${this.store.project(p.projectId).instructions}\n\nUser task:\n${prompt}`
						: prompt,
					model,
				},
				(e) => this.receiveEvent(run, e),
			);
			this.worker = worker;
			if (this.store.state.active)
				this.store.state.active.containerName = worker.name;
			await this.publish();
			if (epoch !== this.epoch || this.closed || this.maintenance) {
				await worker.stop();
				this.worker = undefined;
				delete this.store.state.active;
				session.status = "cancelled";
				await this.publish();
				throw new Error("Submission cancelled");
			}
			this.workerFinished = worker
				.start()
				.catch((e) => {
					this.receiveEvent(run, { type: "error", data: String(e) });
				})
				.finally(async () => {
					if (
						!run.terminal &&
						!["failed", "cancelling"].includes(session.status)
					)
						run.rawStatus = "interrupted";
					session.status = displayedStatus(run, true);
					run.finished = true;
					try {
						await worker.confirmGone();
						if (this.store.state.active?.containerName === worker.name)
							delete this.store.state.active;
					} catch {
						this.recoveryBlocked = true;
						session.status = "recovery-blocked";
					}
					if (execution) {
						execution.status = session.status;
						execution.endedAt = Date.now();
						if (!run.terminal)
							execution.events.push({
								id: randomUUID(),
								type: "ended",
								at: new Date().toISOString(),
								data: session.status,
							});
					}
					await this.publish();
					if (this.worker === worker) this.worker = undefined;
					this.admitted = false;
					this.admittingSessionId = undefined;
					if (this.currentRun === run) this.currentRun = undefined;
					this.titles.kick();
					this.knowledge.kick();
				});
			return { accepted: true };
		} catch (e) {
			try {
				if (epoch !== this.epoch) {
					session.status = "cancelled";
					const owned = this.store.state.active;
					const worker = this.worker;
					if (worker) {
						try {
							await worker.confirmGone();
							if (this.store.state.active === owned)
								delete this.store.state.active;
						} catch {
							this.recoveryBlocked = true;
							session.status = "recovery-blocked";
						}
					} else if (this.store.state.active === owned)
						delete this.store.state.active;
					await this.publish();
				}
			} finally {
				this.admitted = false;
				this.admittingSessionId = undefined;
				if (this.currentRun === run) this.currentRun = undefined;
			}
			throw e;
		}
	}

	private receiveEvent(run: RunControl, event: any) {
		if (this.storageStopped) return;
		const session = run.session;
		const record = {
			id: randomUUID(),
			requestId: run.requestId,
			type: event.type,
			at: new Date().toISOString(),
			data: event.data,
		};
		session.events.push(record);
		run.execution?.events.push(record);
		if (run.finished || this.currentRun !== run) {
			void this.publish().catch(() => {});
			return;
		}
		this.updateRun(run, event);
		session.status = displayedStatus(run);
		if (event.type === "result") session.answer = event.data.answer;
		if (run.execution) {
			run.execution.status = session.status;
			const orbitRunId = event.data?.runId ?? event.data?.runtime?.runId;
			if (typeof orbitRunId === "string") run.execution.orbitRunId = orbitRunId;
			if (event.type === "result") run.execution.answer = event.data.answer;
		}
		void this.publish().catch(() => {});
	}
	private updateRun(run: RunControl, event: any) {
		if (event.type === "model-cancelled") run.modelCancelled = true;
		if (event.type === "error") {
			run.rawStatus = "failed";
			const cancelled = /^Error: (Worker cancelled|Cancelled|Stopped)$/.test(
				String(event.data),
			);
			if (cancelled) run.modelCancelled = true;
			else run.independentFailure = true;
		}
		if (event.type === "approval" && !run.terminal)
			run.rawStatus = "awaiting-approval";
		if (event.type === "run" && !run.terminal) run.rawStatus = event.data.phase;
		const result =
			event.type === "result" ? event.data.runtime : event.data?.result;
		if (result?.outcome) {
			run.terminal = true;
			run.rawStatus = result.outcome;
		}
	}
	async cancel() {
		const run = this.currentRun;
		if (!run) return;
		if (!run.cancellation) {
			run.cancellation = {
				at: new Date().toISOString(),
				effective: !run.terminal && !run.independentFailure,
			};
			if (run.cancellation.effective) ++this.epoch;
			const record = {
				id: randomUUID(),
				requestId: run.requestId,
				type: "cancel-requested",
				at: run.cancellation.at,
				data: { requestId: run.requestId, ...run.cancellation },
			};
			const session = run.session;
			session.events.push(record);
			run.execution?.events.push(record);
			session.status = displayedStatus(run);
			if (run.execution) run.execution.status = session.status;
			await this.publish();
		}
		await this.worker?.stop();
	}

	private requireRenameRevision(p: any) {
		identifier(p.operationId);
		if (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0)
			throw new Error(
				"Expected name revision is required; refresh before renaming",
			);
	}

	private async stopForInitialization(
		mode: InitializationMode,
		includeSettings: boolean,
	) {
		if (
			!["settings", "data", "all"].includes(mode) ||
			(mode !== "data" && includeSettings !== true)
		)
			throw new Error(
				"Select a valid scope and explicitly include its settings",
			);
		this.maintenance = true;
		++this.epoch;
		this.maintenanceError = undefined;
		try {
			await this.initialization.mark("stopping");
			if (!this.storageStopped) {
				await this.titles.close();
				await this.knowledge.close();
				await this.cancel();
				const drained = await Promise.allSettled(this.operations);
				const failed = drained.find(
					(result) =>
						result.status === "rejected" &&
						!/Submission cancelled|App writers are stopped or closing/.test(
							String(result.reason),
						),
				);
				if (failed?.status === "rejected") throw failed.reason;
				await this.workerFinished;
				await this.worker?.confirmGone();
				if (this.recoveryBlocked || this.store.state.active || this.admitted)
					throw new Error(
						"Writer shutdown is not confirmed; initialization refused",
					);
				await this.saveQueue;
				await this.store.close();
				this.storageStopped = true;
			}
			await this.initialization.mark("stopped");
			return await this.initialization.review(mode, includeSettings);
		} catch (error) {
			this.maintenanceError = String(error);
			await this.initialization.mark("failed", this.maintenanceError);
			throw error;
		} finally {
			this.store.state.maintenance = {
				error: this.maintenanceError,
				complete: this.initialization.completed,
			};
			this.changed(structuredClone(this.store.state));
		}
	}
	dispatch(commandName: string, p: any = {}): Promise<any> {
		if (this.closed) return Promise.reject(new Error("App is closing"));
		if (commandName === "initialization-status")
			return Promise.resolve({
				...initializationAvailability,
				root: this.store.root,
				maintenance: this.maintenance,
				error: this.maintenanceError,
				complete: this.initialization.completed,
				plan: this.initialization.finalPreview,
			});
		if (
			commandName === "initialization-stop" ||
			commandName === "initialization-execute"
		) {
			if (this.initialization.completed)
				return Promise.reject(
					new Error("Initialization completed; restart the App"),
				);
			if (this.maintenanceTask)
				return Promise.reject(
					new Error("Initialization operation already running"),
				);
			if (
				commandName === "initialization-execute" &&
				(!this.maintenance || !this.storageStopped)
			)
				return Promise.reject(
					new Error("Stop and verify all writers before initialization"),
				);
			const operation =
				commandName === "initialization-stop"
					? this.stopForInitialization(p.mode, p.includeSettings)
					: this.initialization.execute(p).catch((error) => {
							this.maintenanceError = String(error);
							throw error;
						});
			this.maintenanceTask = operation;
			void operation
				.finally(() => {
					this.maintenanceTask = undefined;
				})
				.catch(() => {});
			return operation;
		}
		if (this.maintenance) {
			if (commandName === "snapshot")
				return Promise.resolve(structuredClone(this.store.state));
			return Promise.reject(
				new Error(
					"App writers are stopped for initialization; review or restart after completion",
				),
			);
		}
		const operation = this.dispatchCommand(commandName, p);
		this.operations.add(operation);
		void operation
			.finally(() => this.operations.delete(operation))
			.catch(() => {});
		return operation;
	}
	private async dispatchCommand(commandName: string, p: any) {
		if (
			["move-session", "select-model", "rename-session"].includes(
				commandName,
			) &&
			this.admittingSessionId === p.sessionId
		)
			throw new Error("Running or recovery-pending sessions cannot be changed");
		switch (commandName) {
			case "initialization-preview":
				return this.initialization.preview(p.mode, p.includeSettings);
			case "tick":
				return this.tickOnce(p.now);
			case "snapshot":
				await this.store.refreshNames();
				return structuredClone(this.store.state);
			case "health":
				return this.health();
			case "create-project": {
				const result = await this.store.createProject(
					p.name,
					p.directory,
					p.instructions,
				);
				await this.publish();
				return result;
			}
			case "edit-project": {
				this.requireRenameRevision(p);
				const result = await this.store.editProject(p);
				await this.publish();
				return result;
			}
			case "select-model": {
				const session = this.store.assertMovable(p.projectId, p.sessionId);
				session.model = text(p.model, 120);
				await this.publish();
				return session;
			}
			case "rename-project": {
				this.requireRenameRevision(p);
				const result = await this.store.renameProject(p);
				await this.publish();
				return result;
			}
			case "rename-session": {
				this.requireRenameRevision(p);
				this.store.assertMovable(p.projectId, p.sessionId);
				await this.titles.interrupt(p.sessionId);
				const result = await this.store.renameSession(p);
				await this.publish();
				return result;
			}
			case "archive-project":
			case "archive-session":
				await this.knowledge.interrupt();
				await this.titles.interrupt(p.sessionId);
				await this.store.setArchived(
					p.projectId,
					commandName === "archive-session" ? p.sessionId : undefined,
					p.archived,
				);
				await this.publish();
				return;
			case "knowledge-status":
				this.store.project(p.projectId);
				return this.knowledge.status(p.projectId);
			case "knowledge-control":
				this.store.project(p.projectId);
				return this.knowledge.configure(p.projectId, p.enabled, p.limits);
			case "knowledge-edit":
				this.store.project(p.projectId);
				return this.knowledge.edit(
					p.projectId,
					p.id,
					text(p.body, 8192),
					p.retired,
					p.expectedRevision,
				);
			case "move-session": {
				await this.knowledge.interrupt();
				const target = p.targetProjectId || (await this.store.chats()).id;
				const result = await this.store.moveSession({
					...p,
					targetProjectId: target,
				});
				await this.publish();
				await this.knowledge.synchronize(p.sessionId);
				return { ...result, projectId: target };
			}
			case "create-session": {
				if (!p.projectId)
					p = { ...p, projectId: (await this.store.chats()).id };
				const result = await this.store.createSession(p.projectId);
				await this.publish();
				return { ...result, projectId: p.projectId };
			}
			case "submit":
				return this.submit(p);
			case "cancel":
				return this.cancel();
			case "approve": {
				if (!this.worker) throw new Error("No active worker");
				this.worker.approve(p.id, p.approve);
				const active = this.store.state.active;
				if (active) {
					const event = {
						id: randomUUID(),
						type: "approval-decision",
						at: new Date().toISOString(),
						data: { id: p.id, approve: p.approve },
					};
					this.store
						.session(active.projectId, active.sessionId)
						.events.push(event);
					const execution = this.store.state.executions?.find(
						(r) => r.sessionId === active.sessionId && !r.endedAt,
					);
					execution?.events.push(event);
				}
				await this.publish();
				return;
			}
			case "artifacts": {
				const entries = await fs.readdir(
					p.sessionId
						? this.store.location(p.projectId, p.sessionId).workspace
						: (this.store.project(p.projectId).directory ??
								this.store.workspace(p.projectId)),
					{ withFileTypes: true },
				);
				return entries.filter((e) => e.isFile()).map((e) => e.name);
			}
			case "appearance": {
				if (!["system", "light", "dark"].includes(p.value))
					throw new Error("Invalid appearance");
				this.store.state.appearance = p.value;
				await this.publish();
				return;
			}
			case "update-schedule":
			case "schedule": {
				this.store.session(p.projectId, p.sessionId);
				const existing =
					commandName === "update-schedule"
						? this.store.state.schedules.find((s) => s.id === identifier(p.id))
						: undefined;
				if (commandName === "update-schedule" && !existing)
					throw new Error("Schedule not found");
				if (
					existing &&
					(existing.projectId !== p.projectId ||
						existing.sessionId !== p.sessionId)
				)
					throw new Error("Schedule moved; refresh before editing.");
				const creationInput = JSON.stringify([
					p.projectId,
					p.sessionId,
					text(p.prompt),
					text(p.model, 120),
					p.timing ?? [p.nextAt, p.intervalMs],
				]);
				if (!existing && p.operationId) {
					identifier(p.operationId);
					const prior = this.store.state.schedules.find(
						(s) => s.creationId === p.operationId,
					);
					if (prior) {
						if (prior.creationInput !== creationInput)
							throw new Error(
								"Schedule creation input changed; start a new task.",
							);
						await this.publish();
						return prior;
					}
				}
				let plan = existing?.plan;
				let at = existing?.nextAt;
				let interval = existing?.intervalMs ?? 0;
				if (p.timing) {
					plan = resolveSchedule(p.timing, Date.now());
					at = plan.firstAt;
					interval =
						plan.repeat.kind === "interval" ? plan.repeat.minutes * 60000 : 0;
				} else if (!existing) {
					at = Number(p.nextAt);
					interval = Number(p.intervalMs);
					if (
						!Number.isFinite(at) ||
						at <= Date.now() ||
						![0, 3600000, 86400000].includes(interval)
					)
						throw new Error("Invalid schedule");
				}

				const s = {
					id: existing?.id ?? randomUUID(),
					creationId: existing?.creationId ?? p.operationId,
					creationInput: existing?.creationInput ?? creationInput,
					plan,
					projectId: p.projectId,
					sessionId: p.sessionId,
					prompt: text(p.prompt),
					model: text(p.model, 120),
					nextAt: Number(at),
					intervalMs: interval,
					enabled: existing?.enabled ?? true,
				};
				if (existing) Object.assign(existing, s);
				else this.store.state.schedules.push(s);
				await this.publish();
				return s;
			}
			case "enable-schedule":
			case "delete-schedule":
			case "disable-schedule": {
				this.knowledge.kick();
				const s = this.store.state.schedules.find(
					(s) => s.id === identifier(p.id),
				);
				if (!s) throw new Error("Schedule not found");
				if (commandName === "delete-schedule") {
					if (p.confirmation !== s.id)
						throw new Error("Confirm deletion of this scheduled task.");
					// Definitions only: admitted executions, history, chats and files survive.
					this.store.state.schedules = this.store.state.schedules.filter(
						(item) => item.id !== s.id,
					);
				} else if (commandName === "enable-schedule") {
					if (s.enabled) return s;
					const oneTime = s.plan
						? s.plan.repeat.kind === "none"
						: s.intervalMs === 0;
					if (
						oneTime &&
						this.store.state.executions?.some(
							(run) => run.scheduleId === s.id && run.dueAt === s.nextAt,
						)
					)
						throw new Error(
							"This one-time task was already admitted. Edit its first-run time before enabling.",
						);
					s.nextAt = resumeOccurrence(s, Date.now());
					s.enabled = true;
				} else s.enabled = false;
				await this.publish();
				return s;
			}
			default:
				throw new Error("Unknown command");
		}
	}
	tick(now = Date.now()) {
		if (this.closed || this.maintenance) return Promise.resolve();
		return this.dispatch("tick", { now });
	}
	private async tickOnce(now = Date.now()) {
		if (this.ticking) return;
		this.ticking = true;
		try {
			if (
				this.admitted ||
				this.closed ||
				this.maintenance ||
				this.recoveryBlocked ||
				this.store.state.active
			)
				return;
			const s = this.store.state.schedules.find(
				(s) =>
					s.enabled &&
					s.nextAt <= now &&
					!this.store.project(s.projectId).archived &&
					!this.store.session(s.projectId, s.sessionId).archived,
			);
			if (!s) {
				this.knowledge.poll();
				return;
			}
			const execution = {
				id: randomUUID(),
				scheduleId: s.id,
				projectId: s.projectId,
				sessionId: s.sessionId,
				projectName: this.store.project(s.projectId).name,
				requestId: randomUUID(),
				dueAt: s.nextAt,
				startedAt: now,
				prompt: s.prompt,
				model: s.model,
				status: "starting",
				events: [] as any[],
			};
			this.store.state.executions ??= [];
			this.store.state.executions.push(execution);
			const next = s.plan
				? nextOccurrence(s.plan, now)
				: s.intervalMs > 0
					? s.nextAt +
						(Math.floor((now - s.nextAt) / s.intervalMs) + 1) * s.intervalMs
					: undefined;
			s.enabled = next !== undefined;
			if (next !== undefined) s.nextAt = next;
			await this.publish();
			try {
				await this.submit(
					{
						projectId: execution.projectId,
						sessionId: execution.sessionId,
						prompt: execution.prompt,
						model: execution.model,
						requestId: execution.requestId,
					},
					true,
				);
			} catch (e) {
				const session = this.store.session(s.projectId, s.sessionId);
				const cancelled =
					execution.events.some(
						(event) =>
							event.type === "cancel-requested" &&
							event.requestId === execution.requestId &&
							event.data.effective,
					) && session.status === "cancelled";
				execution.status = cancelled ? "cancelled" : "failed";
				Object.assign(execution, { endedAt: Date.now() });
				execution.events.push({
					id: randomUUID(),
					type: "error",
					at: new Date().toISOString(),
					data: String(e),
				});
				session.events.push({
					id: randomUUID(),
					type: "schedule-error",
					at: new Date().toISOString(),
					data: String(e),
				});
				await this.publish();
			}
		} finally {
			this.ticking = false;
		}
	}

	async close() {
		this.closed = true;
		if (this.maintenance) {
			await this.maintenanceTask?.catch(() => {});
			if (!this.storageStopped) {
				await this.titles.close();
				await this.knowledge.close();
				await this.cancel();
				await Promise.allSettled(this.operations);
				await this.workerFinished;
				await this.saveQueue;
				await this.store.close();
				this.storageStopped = true;
			}
			return;
		}
		await this.titles.close();
		await this.knowledge.close();
		await this.cancel();
		await Promise.allSettled(this.operations);
		await this.workerFinished;
		await this.saveQueue;
		await this.store.close();
	}
}

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store, text, identifier } from "./store";
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
	worker?: Worker;
	private admitted = false;
	private currentRun?: RunControl;
	private admittingSessionId?: string;
	private epoch = 0;
	private closed = false;
	private recoveryBlocked = false;
	private reconciling?: Promise<void>;
	private saveQueue = Promise.resolve();
	constructor(
		root: string,
		private changed: (state: Snapshot) => void,
		private factory = (
			workspace: string,
			core: string,
			config: any,
			event: (e: any) => void,
		) => new Worker(workspace, core, config, event),
	) {
		this.store = new Store(root);
	}
	async init() {
		await this.store.init();
		await this.reconcile();
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
		this.store.state.recoveryBlocked = this.recoveryBlocked;
		this.changed(structuredClone(this.store.state));
		this.saveQueue = this.saveQueue.then(() => this.store.save());
		await this.saveQueue;
	}
	async health(): Promise<Health> {
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
	async submit(p: any) {
		const execution = this.store.state.executions?.find(
			(r) => r.requestId === p.requestId,
		);
		if (this.closed) throw new Error("App is closing");
		if (this.admitted) throw new Error("A worker is already active");
		const session = this.store.session(p.projectId, p.sessionId);
		const prompt = text(p.prompt);
		const model = text(p.model, 120);
		identifier(p.requestId);
		if (
			session.events.some(
				(e) => e.type === "submission" && e.data.requestId === p.requestId,
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
			const health = await this.health();
			if (epoch !== this.epoch || this.closed)
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
			if (epoch !== this.epoch || this.closed)
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
			if (epoch !== this.epoch || this.closed)
				throw new Error("Submission cancelled");
			const worker = this.factory(
				workspace,
				this.store.location(p.projectId, p.sessionId).core,
				{
					sessionId: p.sessionId,
					requestId: p.requestId,
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
			if (epoch !== this.epoch || this.closed) {
				await worker.stop();
				this.worker = undefined;
				delete this.store.state.active;
				session.status = "cancelled";
				await this.publish();
				throw new Error("Submission cancelled");
			}
			void worker
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

	async dispatch(commandName: string, p: any = {}) {
		if (
			["move-session", "select-model"].includes(commandName) &&
			this.admittingSessionId === p.sessionId
		)
			throw new Error("Running or recovery-pending sessions cannot be changed");
		switch (commandName) {
			case "snapshot":
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
				const result = await this.store.renameProject(p);
				await this.publish();
				return result;
			}
			case "rename-session": {
				const result = await this.store.renameSession(p);
				await this.publish();
				return result;
			}
			case "move-session": {
				const target = p.targetProjectId || (await this.store.chats()).id;
				const result = await this.store.moveSession({
					...p,
					targetProjectId: target,
				});
				await this.publish();
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
			case "schedule": {
				this.store.session(p.projectId, p.sessionId);
				const at = Number(p.nextAt),
					interval = Number(p.intervalMs);
				if (
					!Number.isFinite(at) ||
					at <= Date.now() ||
					![0, 3600000, 86400000].includes(interval)
				)
					throw new Error("Invalid schedule");
				const s = {
					id: randomUUID(),
					projectId: p.projectId,
					sessionId: p.sessionId,
					prompt: text(p.prompt),
					model: text(p.model, 120),
					nextAt: at,
					intervalMs: interval,
					enabled: true,
				};
				this.store.state.schedules.push(s);
				await this.publish();
				return s;
			}
			case "disable-schedule": {
				const s = this.store.state.schedules.find(
					(s) => s.id === identifier(p.id),
				);
				if (!s) throw new Error("Schedule not found");
				s.enabled = false;
				await this.publish();
				return;
			}
			default:
				throw new Error("Unknown command");
		}
	}
	async tick(now = Date.now()) {
		if (
			this.admitted ||
			this.closed ||
			this.recoveryBlocked ||
			this.store.state.active
		)
			return;
		const s = this.store.state.schedules.find(
			(s) => s.enabled && s.nextAt <= now,
		);
		if (!s) return;
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
		s.enabled = s.intervalMs > 0;
		s.nextAt = now + s.intervalMs;
		await this.publish();
		try {
			await this.submit({ ...s, requestId: execution.requestId });
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
	}
	async close() {
		this.closed = true;
		await this.cancel();
		await this.saveQueue;
	}
}

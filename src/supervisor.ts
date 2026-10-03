import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store, text, identifier } from "./store";
import { Worker, command, dockerPath, image } from "./worker";
import type { Health, Snapshot } from "./types";
export class Supervisor {
	readonly store: Store;
	worker?: Worker;
	private admitted = false;
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
					throw Error("Invalid saved worker identity");
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
					if (owner.trim() !== this.store.workspace(a.projectId))
						throw Error("Worker ownership mismatch");
					await command(dockerPath, ["rm", "-f", a.containerName]);
				}
			}
			this.store.session(a.projectId, a.sessionId).status = "interrupted";
			if (this.store.state.active === a) delete this.store.state.active;
			this.recoveryBlocked = false;
			await this.publish();
		} catch {
			/* Keep durable identity and block new work until Docker recovers. */
		}
	}
	async publish() {
		this.changed(structuredClone(this.store.state));
		this.saveQueue = this.saveQueue.then(() => this.store.save());
		await this.saveQueue;
	}
	async health(): Promise<Health> {
		if (this.recoveryBlocked) await this.reconcile();
		const health: Health = {
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
			if (!r.ok) throw Error(`Ollama ${r.status}`);
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
		if (this.closed) throw Error("App is closing");
		if (this.admitted) throw Error("A worker is already active");
		const session = this.store.session(p.projectId, p.sessionId);
		const prompt = text(p.prompt);
		const model = text(p.model, 120);
		identifier(p.requestId);
		if (
			session.events.some(
				(e) => e.type === "submission" && e.data.requestId === p.requestId,
			)
		)
			throw Error("Duplicate request");
		this.admitted = true;
		const epoch = ++this.epoch;
		try {
			const health = await this.health();
			if (epoch !== this.epoch || this.closed)
				throw Error("Submission cancelled");
			if (this.recoveryBlocked)
				throw Error(
					"Previous worker recovery is blocked; reconnect Docker first",
				);
			if (!health.docker || !health.ollama || !health.image)
				throw Error(
					"Docker, worker image, and Ollama must be available. Check health and build the worker image.",
				);
			if (!health.models.includes(model))
				throw Error("Select an installed tool-capable model");
			session.status = "starting";
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
				throw Error("Submission cancelled");
			let terminal = false;
			const worker = this.factory(
				this.store.workspace(p.projectId),
				this.store.core(p.projectId),
				{ sessionId: p.sessionId, requestId: p.requestId, prompt, model },
				(e) => {
					if (session.events.length >= 2000) session.events.shift();
					session.events.push({
						id: randomUUID(),
						type: e.type,
						at: new Date().toISOString(),
						data: e.data,
					});
					if (e.type === "approval") session.status = "awaiting-approval";
					if (e.type === "run") session.status = e.data.phase;
					if (e.type === "result") {
						terminal = true;
						session.answer = e.data.answer;
						session.status = e.data.runtime.outcome;
					}
					if (e.type === "error") session.status = "failed";
					void this.publish().catch(() => {});
				},
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
				throw Error("Submission cancelled");
			}
			void worker
				.start()
				.catch((e) => {
					session.status = "failed";
					session.events.push({
						id: randomUUID(),
						type: "error",
						at: new Date().toISOString(),
						data: String(e),
					});
				})
				.finally(async () => {
					if (!terminal && !["failed", "cancelling"].includes(session.status))
						session.status = "interrupted";
					if (session.status === "cancelling") session.status = "cancelled";
					try {
						await worker.confirmGone();
						if (this.store.state.active?.containerName === worker.name)
							delete this.store.state.active;
					} catch {
						this.recoveryBlocked = true;
						session.status = "recovery-blocked";
					}
					await this.publish();
					if (this.worker === worker) this.worker = undefined;
					this.admitted = false;
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
			}
			throw e;
		}
	}

	async cancel() {
		++this.epoch;
		const a = this.store.state.active;
		if (a) this.store.session(a.projectId, a.sessionId).status = "cancelling";
		await this.publish();
		await this.worker?.stop();
	}
	async dispatch(commandName: string, p: any = {}) {
		switch (commandName) {
			case "snapshot":
				return structuredClone(this.store.state);
			case "health":
				return this.health();
			case "create-project": {
				const result = await this.store.createProject(p.name);
				await this.publish();
				return result;
			}
			case "create-session": {
				const result = await this.store.createSession(p.projectId);
				await this.publish();
				return result;
			}
			case "submit":
				return this.submit(p);
			case "cancel":
				return this.cancel();
			case "approve":
				if (!this.worker) throw Error("No active worker");
				this.worker.approve(p.id, p.approve);
				return;
			case "artifacts": {
				const entries = await fs.readdir(
					this.store.workspace(this.store.project(p.projectId).id),
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
					throw Error("Invalid schedule");
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
				if (!s) throw Error("Schedule not found");
				s.enabled = false;
				await this.publish();
				return;
			}
			default:
				throw Error("Unknown command");
		}
	}
	async tick(now = Date.now()) {
		if (this.admitted) return;
		const s = this.store.state.schedules.find(
			(s) => s.enabled && s.nextAt <= now,
		);
		if (!s) return;
		s.enabled = s.intervalMs > 0;
		s.nextAt = now + s.intervalMs;
		await this.publish();
		try {
			await this.submit({ ...s, requestId: randomUUID() });
		} catch (e) {
			const session = this.store.session(s.projectId, s.sessionId);
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

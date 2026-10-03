import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const image = "orbit-app-worker:0.1.0";
export const dockerPath =
	process.platform === "darwin" ? "/usr/local/bin/docker" : "docker";
export function dockerArgs(name: string, workspace: string, core: string) {
	return [
		"run",
		"--rm",
		"-i",
		"--name",
		name,
		"--label",
		`org.cybergarage.orbit-app.workspace=${workspace}`,
		"--ulimit",
		"fsize=67108864:67108864",
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		"128",
		"--memory",
		"2g",
		"--cpus",
		"2",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=256m",
		"--mount",
		`type=bind,src=${workspace},dst=/workspace`,
		"--mount",
		`type=bind,src=${core},dst=/state`,
		image,
	];
}
export function command(
	exe: string,
	args: string[],
	timeout = 10000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const c = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "",
			err = "";
		const timer = setTimeout(() => {
			c.kill("SIGKILL");
			reject(Error("Command timeout"));
		}, timeout);
		c.stdout.on("data", (b) => {
			out += b;
			if (out.length > 1e6) c.kill("SIGKILL");
		});
		c.stderr.on("data", (b) => {
			err += b;
		});
		c.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		c.on("close", (code) => {
			clearTimeout(timer);
			code === 0
				? resolve(out)
				: reject(Error(err.slice(-2000) || `Exit ${code}`));
		});
	});
}
export async function modelRequest(
	route: string,
	body: any,
	model: string,
	signal: AbortSignal,
) {
	if (!["chat", "show", "ps"].includes(route))
		throw Error("Model route denied");
	const payload =
		route === "ps"
			? undefined
			: route === "show"
				? { model }
				: {
						...body,
						model,
						stream: false,
						think: false,
						keep_alive: "60s",
						options: {
							num_ctx: 8192,
							num_predict: 1024,
							temperature: 0,
							seed: 42,
						},
					};
	if (JSON.stringify(payload ?? {}).length > 512000)
		throw Error("Model request too large");
	const r = await fetch(`http://127.0.0.1:11434/api/${route}`, {
		method: payload ? "POST" : "GET",
		headers: { "Content-Type": "application/json" },
		body: payload ? JSON.stringify(payload) : undefined,
		signal,
	});
	if (!r.ok)
		throw Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 1000)}`);
	return r.json();
}
export class Worker {
	readonly name = `orbit-app-${randomUUID()}`;
	child?: ChildProcessWithoutNullStreams;
	readonly controller = new AbortController();
	approval?: any;
	private stopping = false;
	private timer?: NodeJS.Timeout;
	private modelCalls = 0;
	private rpcCalls = 0;
	private rpcActive = 0;
	private rpcIds = new Set<string>();
	private diskTimer?: NodeJS.Timeout;
	constructor(
		private workspace: string,
		private core: string,
		private config: any,
		private event: (data: any) => void,
	) {}
	start(): Promise<void> {
		if (this.stopping)
			return Promise.reject(Error("Worker cancelled before start"));
		return new Promise((resolve, reject) => {
			const c = spawn(
				dockerPath,
				dockerArgs(this.name, this.workspace, this.core),
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			this.started = true;
			this.child = c;
			c.stdin.on("error", () => {});
			this.diskTimer = setInterval(
				() =>
					void projectBytes([this.workspace, this.core])
						.then((bytes) => {
							if (bytes > 268435456) {
								this.event({
									type: "error",
									data: "Project storage budget exceeded",
								});
								this.requestStop();
							}
						})
						.catch(() => this.requestStop()),
				1000,
			);
			this.timer = setTimeout(() => this.requestStop(), 240000);
			const lines = createInterface({ input: c.stdout });
			let total = 0;
			lines.on("line", (line) => {
				total += line.length;
				if (line.length > 2e6 || total > 8e6) {
					this.requestStop();
					return;
				}
				try {
					const e = JSON.parse(line);
					if (e.type === "rpc") void this.rpc(e);
					else if (e.type === "approval") {
						this.approval = e.data;
						this.event(e);
					} else this.event(e);
				} catch {
					this.event({
						type: "protocol-error",
						data: "Invalid worker message",
					});
				}
			});
			c.stderr.on("data", (b) =>
				this.event({ type: "worker-log", data: String(b).slice(0, 2000) }),
			);
			c.on("error", (e) => {
				clearTimeout(this.timer);
				clearInterval(this.diskTimer);
				reject(e);
			});
			c.on("close", (code) => {
				clearTimeout(this.timer);
				clearInterval(this.diskTimer);
				this.controller.abort();
				lines.close();
				this.child = undefined;
				this.approval = undefined;
				code === 0 || this.stopping
					? resolve()
					: reject(Error(`Worker exited ${code}`));
			});
			this.send({ type: "start", config: this.config });
		});
	}
	send(data: any) {
		this.child?.stdin.write(`${JSON.stringify(data)}\n`);
	}
	async rpc(e: any) {
		if (this.stopping || this.controller.signal.aborted) return;
		if (
			typeof e.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(e.id) ||
			this.rpcIds.has(e.id) ||
			!["chat", "show", "ps"].includes(e.route) ||
			++this.rpcCalls > 32 ||
			this.rpcActive >= 2
		) {
			this.event({
				type: "error",
				data: "Model gateway protocol/budget rejected",
			});
			this.requestStop();
			return;
		}
		this.rpcIds.add(e.id);
		this.rpcActive++;
		try {
			if (e.route === "chat" && ++this.modelCalls > 9)
				throw Error("Model call budget exceeded");
			const data = await modelRequest(
				e.route,
				e.body,
				this.config.model,
				this.controller.signal,
			);
			this.send({ type: "rpc-result", id: e.id, data });
		} catch (error) {
			this.send({ type: "rpc-result", id: e.id, error: String(error) });
		} finally {
			this.rpcActive--;
		}
	}
	approve(id: unknown, approve: unknown) {
		if (
			this.stopping ||
			this.controller.signal.aborted ||
			!this.approval ||
			this.approval.expiresAt <= Date.now() ||
			id !== this.approval.id ||
			typeof approve !== "boolean"
		)
			throw Error("Approval is no longer pending");
		this.send({ type: "approval-reply", data: { ...this.approval, approve } });
		this.approval = undefined;
	}
	async confirmGone() {
		if (!this.child && !this.started) return;
		const names = await command(dockerPath, [
			"ps",
			"-a",
			"--filter",
			`name=^/${this.name}$`,
			"--format",
			"{{.Names}}",
		]);
		if (names.trim()) throw Error("Worker cleanup not confirmed");
	}
	private started = false;
	private stopPromise?: Promise<void>;
	requestStop() {
		void this.stop().catch((error) =>
			this.event({ type: "cleanup-error", data: String(error) }),
		);
	}
	stop() {
		if (!this.stopPromise) this.stopPromise = this.stopOnce();
		return this.stopPromise;
	}
	async stopOnce() {
		if (this.stopping) return;
		this.stopping = true;
		this.approval = undefined;
		this.controller.abort();
		this.send({ type: "stop" });
		if (!this.started) return;
		try {
			await command(dockerPath, ["stop", "-t", "3", this.name]).catch(() => {});
			const names = await command(dockerPath, [
				"ps",
				"-a",
				"--filter",
				`name=^/${this.name}$`,
				"--format",
				"{{.Names}}",
			]);
			if (names.trim()) await command(dockerPath, ["rm", "-f", this.name]);
			await this.confirmGone();
		} finally {
			this.child?.kill("SIGKILL");
		}
	}
}

export async function projectBytes(roots: string[]): Promise<number> {
	let size = 0,
		count = 0;
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (++count > 10000) {
				size = 268435457;
				return;
			}
			if (entry.isSymbolicLink()) continue;
			const target = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(target);
			else if (entry.isFile()) size += (await fs.stat(target)).size;
			if (size > 268435456) return;
		}
	}
	for (const root of roots) {
		await walk(root);
		if (size > 268435456) break;
	}
	return size;
}

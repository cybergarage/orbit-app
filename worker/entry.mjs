import { decideOperation } from "./policy.mjs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
	Agent,
	Message,
	SessionRepository,
	State,
	MemorySessionLogStore,
	createModelContextPolicy,
} from "@cybergarage/orbit";
import { OllamaAgent } from "@cybergarage/orbit/dist/core/models/adapters/ollama.js";
const emit = (type, data) =>
	process.stdout.write(`${JSON.stringify({ type, data })}\n`);
const pending = new Map();
let agent,
	handle,
	started = false;
let connectionLost = false;
function rpc(route, body) {
	if (connectionLost) return Promise.reject(Error("Host connection lost"));
	const id = randomUUID();
	process.stdout.write(`${JSON.stringify({ type: "rpc", id, route, body })}\n`);
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, () => {
		handle?.requestStop("Worker stopped");
		for (const p of pending.values()) p.reject(Error("Stopped"));
		pending.clear();
	});
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	try {
		const e = JSON.parse(line);
		if (e.type === "rpc-result") {
			const p = pending.get(e.id);
			pending.delete(e.id);
			e.error ? p?.reject(Error(e.error)) : p?.resolve(e.data);
		} else if (e.type === "start" && !started) {
			started = true;
			void run(e.config);
		} else if (e.type === "stop") {
			handle?.requestStop("User cancelled");
			for (const p of pending.values()) p.reject(Error("Cancelled"));
			pending.clear();
		} else if (e.type === "approval-reply") {
			const a = e.data;
			void agent
				?.replyApproval(a.runId, {
					requestId: a.id,
					digest: a.digest,
					responderScope: a.responderScope,
					approve: a.approve,
				})
				.catch((error) => emit("error", String(error)));
		}
	} catch (error) {
		emit("error", String(error));
	}
});
lines.on("close", () => {
	connectionLost = true;
	handle?.requestStop("Host connection lost");
	for (const p of pending.values()) p.reject(Error("Host connection lost"));
	pending.clear();
});
async function run(config) {
	let session;
	try {
		const repo = new SessionRepository({
			rootDir: "/state/sessions",
			journalRoot: "/state/runs",
		});
		if (repo.inspectStorage().state === "unregistered")
			repo.initializeStorage({
				allWritersStopped: true,
				automaticRestartersDisabled: true,
				exclusiveStorageControl: true,
			});
		const existing = await repo.findById(config.sessionId);
		session = existing
			? repo.open(existing.file)
			: repo.create({
					id: config.sessionId,
					formatVersion: 3,
					cwd: "/workspace",
					model: config.model,
					provider: "ollama",
					originator: "orbit-app",
				});
		const model = new OllamaAgent(
			config.model,
			{ getName: () => "ollama", getContextWindow: () => 8192 },
			{
				client: {
					chat: (request) => rpc("chat", request),
					ps: () => rpc("ps"),
					show: (request) => rpc("show", request),
					abort: () => {
						for (const p of pending.values()) p.reject(Error("Cancelled"));
						pending.clear();
					},
				},
			},
		);
		const contextPolicy = await createModelContextPolicy(model, {
			outputReserve: 1024,
		});
		agent = new Agent({
			cwd: "/workspace",
			state: new State(session),
			deps: { createModel: () => model },
			contextPolicy,
			settings: {
				provider: "ollama",
				model: config.model,
				tools: { profile: "coding" },
				mcp: { servers: {} },
			},
			logStore: new MemorySessionLogStore(),
			toolProfile: "coding",
			execution: {
				journalLevel: "file-and-directory-sync",
				journalRoot: "/state/runs",
				responderScope: "desktop-owner",
				limits: {
					elapsedMs: 210000,
					approvalMs: 60000,
					modelCalls: 9,
					toolRounds: 8,
					toolRequests: 24,
					cleanupMs: 3000,
					mcpServers: 0,
				},
				policy: {
					generation: "orbit-app-container-v1",
					decide: decideOperation,
					profile: "workspace-confirm",
					roots: ["/workspace"],
				},
				onApproval: (request) => emit("approval", request),
			},
		});
		if (connectionLost)
			throw Error("Host connection lost before run admission");
		handle = await agent.startRun(
			[new Message("user", { content: config.prompt })],
			{
				requestId: config.requestId,
				maxToolIterations: 8,
				onEvent: (event) => emit("agent-event", event),
				onRunSnapshot: (snapshot) => emit("run", snapshot),
			},
		);
		const runtime = await handle.finished;
		emit("result", {
			runtime,
			answer: handle.value()?.content ?? "",
			entries: session.getEntries(),
		});
	} catch (error) {
		emit("error", String(error));
		process.exitCode = 1;
	} finally {
		await agent?.close().catch((error) => emit("error", String(error)));
		await session?.close().catch((error) => emit("error", String(error)));
		emit(
			"artifacts",
			fs
				.readdirSync("/workspace", { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => e.name),
		);
		lines.close();
		process.stdin.destroy();
	}
}

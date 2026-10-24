import { installBackgroundWindows } from "../../src/background-windows";
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { ContainerCoreNames } from "../../src/core-names";
import { Supervisor } from "../../src/supervisor";
const root = process.env.ORBIT_KNOWLEDGE_ROOT;
const dist = process.env.ORBIT_KNOWLEDGE_DIST;
if (!root || !dist)
	throw new Error("Missing synthetic knowledge fixture paths");
const fixturePaths = { root, dist };
app.setPath("userData", path.join(root, "electron"));
const metadataTrace: unknown[] = [];
const originalCall = ContainerCoreNames.prototype.call;
ContainerCoreNames.prototype.call = async function (core, request) {
	const entry = {
		command: request.command,
		query: request.query,
		projectId: request.projectId,
		configId: (request.mutation as any)?.config?.id,
		core,
		started: Date.now(),
		resultId: undefined as string | undefined,
		completed: undefined as number | undefined,
		error: undefined as string | undefined,
	};
	metadataTrace.push(entry);
	if (metadataTrace.length > 500) metadataTrace.shift();
	try {
		const result = await originalCall.call(this, core, request);
		entry.resultId = result?.id;
		return result;
	} catch (error) {
		entry.error = String(error);
		throw error;
	} finally {
		entry.completed = Date.now();
	}
};
let supervisor: Supervisor;
let closing = false;
let window: BrowserWindow | undefined;
let releaseLearning!: () => void;
const learningGate = new Promise<void>((resolve) => {
	releaseLearning = resolve;
});
const extract = async (input: string) => {
	await learningGate;
	const source = JSON.parse(input).messages.find(
		(message: any) =>
			message.role === "user" && message.text.startsWith("Use PostgreSQL"),
	);
	return {
		inputTokens: 200,
		outputTokens: 30,
		text: JSON.stringify({
			candidates: source
				? [
						{
							title: "Database",
							body: "Use PostgreSQL for the catalog.",
							kind: "decision",
							importance: 3,
							condition: "Catalog",
							messageId: source.id,
							quote: source.text,
						},
					]
				: [],
		}),
	};
};
globalThis.fetch = async (url, options) => {
	const route = String(url).split("/").at(-1);
	const body = options?.body ? JSON.parse(String(options.body)) : {};
	if (route === "ps") return Response.json({ models: [] });
	if (route === "show")
		return Response.json({
			model_info: { "gemma4.context_length": 8192 },
			capabilities: ["tools", "completion"],
		});
	if (route !== "chat") throw new Error("Unexpected fixture network request");
	const input = JSON.stringify(body.messages),
		last = body.messages.at(-1)?.content ?? "";
	return Response.json({
		model: "gemma4:12b",
		done: true,
		done_reason: "stop",
		created_at: new Date().toISOString(),
		eval_duration: 1,
		prompt_eval_duration: 1,
		load_duration: 1,
		total_duration: 2,
		prompt_eval_count: 120,
		eval_count: 10,
		message: {
			role: "assistant",
			content: last.includes("Which database")
				? input.includes("Untrusted Project memory") &&
					input.includes("Use PostgreSQL")
					? "PostgreSQL selected"
					: "NO_MEMORY"
				: "Acknowledged",
		},
	});
};
async function openWindow() {
	if (!supervisor || closing) return;
	if (window && !window.isDestroyed()) {
		window.show();
		return;
	}
	window = new BrowserWindow({
		width: 1250,
		height: 900,
		webPreferences: {
			preload: path.join(fixturePaths.dist, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	await window.loadFile(path.join(fixturePaths.dist, "index.html"));
}
installBackgroundWindows(app, openWindow);
async function start() {
	await app.whenReady();
	supervisor = new Supervisor(
		fixturePaths.root,
		(state) => {
			if (window && !window.isDestroyed())
				window.webContents.send("orbit:state", state);
		},
		undefined,
		async () => {
			throw new Error("No title model in synthetic UI fixture");
		},
		{ extract },
	);
	await supervisor.init();
	supervisor.health = async () => {
		const health = {
			docker: true,
			ollama: true,
			image: true,
			models: ["gemma4:12b"],
			detail: [],
		};
		supervisor.store.state.health = health;
		await supervisor.publish();
		return health;
	};
	await supervisor.health();
	const limitRequests: unknown[] = [];
	const ipcTrace: any[] = [];
	let nextControlReply: Promise<void> | undefined;
	let releaseControlReply = () => {};
	ipcMain.handle("orbit:call", async (_event, command, payload) => {
		const started = Date.now();
		const trace: any = { command, projectId: payload?.projectId, started };
		if (command.startsWith("knowledge-")) {
			ipcTrace.push(trace);
			if (ipcTrace.length > 200) ipcTrace.shift();
		}
		const reply =
			command === "knowledge-control" ? nextControlReply : undefined;
		if (reply) nextControlReply = undefined;
		let result: unknown;
		try {
			result = await supervisor.dispatch(command, payload);
			if (command === "knowledge-status")
				trace.savedConfig = (result as any).config;
			trace.dispatched = Date.now();
			if (reply) await reply;
			trace.completed = Date.now();
		} catch (error) {
			trace.completed = Date.now();
			trace.error = String(error);
			const reader = new ContainerCoreNames(fixturePaths.root);
			try {
				const catalog = await reader.call(
					path.join(fixturePaths.root, "catalog"),
					{ command: "catalog-query", query: { kind: "projects", limit: 100 } },
				);
				metadataTrace.push({
					failedCommand: command,
					payload,
					registry: supervisor.store.state.projects.map((p) => p.id),
					catalog: catalog.map((p: any) => p.id),
				});
			} finally {
				await reader.close();
			}
			throw error;
		}
		if (command === "knowledge-control" && payload.limits)
			limitRequests.push({ limits: payload.limits, ms: Date.now() - started });
		return result;
	});
	(globalThis as any).knowledgeControl = {
		supervisor,
		releaseLearning,
		limitRequests,
		metadataTrace,
		ipcTrace,
		holdNextControlReply() {
			nextControlReply = new Promise<void>((resolve) => {
				releaseControlReply = resolve;
			});
		},
		releaseControlReply() {
			releaseControlReply();
		},
	};
	await openWindow();
}
void start();
app.on("before-quit", (event) => {
	if (closing) return;
	event.preventDefault();
	closing = true;
	void supervisor?.close().finally(() => app.quit());
});

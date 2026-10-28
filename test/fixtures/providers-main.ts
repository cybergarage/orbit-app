import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Supervisor } from "../../src/supervisor";
import type { ProviderCatalog, ModelsHost } from "../../src/core-models";
import type { Worker } from "../../src/worker";
function fixturePath(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error("Missing isolated provider fixture path");
	return value;
}
const root = fixturePath("ORBIT_PROVIDER_ROOT");
const dist = fixturePath("ORBIT_PROVIDER_DIST");
app.setPath("userData", path.join(root, "electron"));
let sup: Supervisor;
let closing = false;
async function start() {
	await app.whenReady();
	let window: BrowserWindow;
	const control = { fail: false, configs: [] as any[], finish: () => {} };
	const catalog = (): ProviderCatalog => ({
		checkedAt: Date.now(),
		expiresAt: Date.now() + 30000,
		providers: [
			["ollama", "Ollama", "local-fixture"],
			["anthropic", "Claude (Anthropic)", "claude-fixture"],
			["openai", "OpenAI", "gpt-4o"],
		].map(([provider, label, model]) => ({
			provider,
			label,
			status: "available",
			credential: provider === "ollama" ? "not-required" : "list-verified",
			models: [{ provider, model, label: model, tools: true }],
		})),
	});
	const host: ModelsHost = {
		catalog: async () => {
			if (control.fail) throw Error("Catalog unavailable fixture");
			return catalog();
		},
		request: async () => {
			throw Error("Inference is not used by this UI fixture");
		},
	};
	sup = new Supervisor(
		root,
		(state) => window?.webContents.send("orbit:state", state),
		(_workspace, _core, config, event) => {
			control.configs.push(structuredClone(config));
			return {
				name: "provider-fixture",
				start: () =>
					new Promise<void>((resolve) => {
						control.finish = () => {
							event({
								type: "result",
								data: {
									answer: "Mocked response",
									runtime: { outcome: "completed" },
								},
							});
							resolve();
						};
					}),
				stop: async () => control.finish(),
				confirmGone: async () => {},
			} as unknown as Worker;
		},
		undefined,
		{},
		host,
	);
	sup.knowledge.prepare = async () => undefined;
	sup.knowledge.kick = () => {};
	sup.store.refreshNames = async () => {
		for (const project of sup.store.state.projects) {
			project.name = "Provider fixture";
			for (const session of project.sessions) session.name = "First chat";
		}
	};
	sup.store.executionWorkspace = async () => root;
	sup.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["local-fixture"],
		catalog: catalog(),
		detail: [],
	});
	let prior = true;
	try {
		await fs.access(path.join(root, "registry", "state.json"));
	} catch {
		prior = false;
	}
	await sup.store.init();
	if (!prior) {
		sup.store.state.projects = [
			{
				id: randomUUID(),
				name: "Provider fixture",
				sessions: [
					{
						id: randomUUID(),
						name: "First chat",
						status: "idle",
						events: [],
						model: "local-fixture",
						provider: "ollama",
					},
				],
			},
		];
		sup.store.state.health = await sup.health();
		await sup.store.save();
	}
	ipcMain.handle("orbit:call", (_event, command, payload) =>
		sup.dispatch(command, payload),
	);
	(globalThis as any).providerControl = control;
	window = new BrowserWindow({
		width: 1250,
		height: 840,
		webPreferences: {
			preload: path.join(dist, "preload.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	await window.loadFile(path.join(dist, "index.html"));
}
void start().catch((error) => {
	console.error("Provider fixture startup failed", error);
	app.exit(1);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
	if (closing) return;
	event.preventDefault();
	closing = true;
	void sup?.close().finally(() => app.quit());
});

import { installBackgroundWindows } from "./background-windows";
import { app, BrowserWindow, ipcMain, dialog, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./supervisor";
import { openHostAgentProfile, selectHostAgent } from "./host-profile";
import { createDockerHostWriter } from "./host-agent";
import { createDockerHostCommandProbe } from "./workspace-readiness";
// Only the native-addon package enables the default. Source and legacy
// package builds still support the explicit development opt-in.
declare const __ORBIT_APP_FRESH_HOST_DEFAULT__: boolean;
let window: BrowserWindow;
let supervisor: Supervisor;
let closing = false;
let timer: NodeJS.Timeout;
const testMode = process.env.ORBIT_APP_TEST === "1";
if (testMode && process.env.ORBIT_APP_DATA)
	app.setPath("userData", process.env.ORBIT_APP_DATA);
let hostAgent = false;
try {
	const baseProfile = app.getPath("userData");
	hostAgent = selectHostAgent(
		baseProfile,
		process.env.ORBIT_APP_HOST_AGENT,
		app.isPackaged && __ORBIT_APP_FRESH_HOST_DEFAULT__,
	);
	if (hostAgent) app.setPath("userData", openHostAgentProfile(baseProfile));
} catch (error) {
	if (testMode) console.error(String(error));
	else
		dialog.showErrorBox(
			"Orbit App could not select a safe profile",
			String(error),
		);
	app.exit(1);
	throw error;
}
const profileOwned = app.requestSingleInstanceLock();
if (!profileOwned) {
	if (hostAgent) app.exit(0);
	else app.quit();
}
const entry = path.join(__dirname, "index.html");
async function openWindow() {
	if (!supervisor || closing) return;
	if (window && !window.isDestroyed()) {
		window.show();
		window.focus();
		return;
	}
	window = new BrowserWindow({
		width: 1250,
		height: 840,
		minWidth: 900,
		minHeight: 620,
		title: "Orbit App",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d211f" : "#faf9f6",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (e) => e.preventDefault());

	await window.loadFile(entry);
}
installBackgroundWindows(
	app,
	openWindow,
	testMode && process.env.ORBIT_APP_KEEPALIVE_TEST !== "1",
);
async function start() {
	try {
		await app.whenReady();
		supervisor = new Supervisor(
			app.getPath("userData"),
			(state) => {
				nativeTheme.themeSource = state.appearance ?? "system";
				if (window && !window.isDestroyed())
					window.setBackgroundColor(
						nativeTheme.shouldUseDarkColors ? "#1d211f" : "#faf9f6",
					);
				if (!window?.isDestroyed())
					window?.webContents.send("orbit:state", state);
			},
			undefined,
			testMode && process.env.ORBIT_APP_LIVE !== "1"
				? () => Promise.reject(new Error("Title model disabled in UI fixtures"))
				: undefined,
			testMode && process.env.ORBIT_APP_LIVE !== "1"
				? { extract: async () => ({ text: '{"candidates":[]}' }) }
				: undefined,
			undefined,
			hostAgent,
			undefined,
			hostAgent && process.env.ORBIT_APP_HOST_AGENT_FILE_CHANGES === "1"
				? createDockerHostWriter()
				: undefined,
			hostAgent && process.env.ORBIT_APP_HOST_AGENT_READINESS_PROBE === "1"
				? createDockerHostCommandProbe()
				: undefined,
		);
		await supervisor.init();
		nativeTheme.themeSource = supervisor.store.state.appearance ?? "system";
		ipcMain.handle("orbit:call", (event, command, payload) => {
			if (
				!window ||
				window.isDestroyed() ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				fileURLToPath(event.senderFrame.url) !== entry
			)
				throw new Error("Untrusted IPC sender");
			if (command === "initialization-restart") {
				if (!supervisor.initialization.completed)
					throw new Error(
						"Initialization must complete before restarting writers",
					);
				app.relaunch();
				app.quit();
				return;
			}
			return supervisor.dispatch(command, payload);
		});
		await openWindow();
		timer = setInterval(
			() => void supervisor.tick().catch(console.error),
			15000,
		);
		if (!(testMode && process.env.ORBIT_APP_NO_HEALTH_TEST === "1"))
			void supervisor.dispatch("health").catch(() => {});
	} catch (error) {
		if (hostAgent) await supervisor?.close().catch(console.error);
		if (testMode) console.error(String(error));
		else
			dialog.showErrorBox("Orbit App could not open its data", String(error));
		app.exit(1);
	}
}
if (profileOwned) void start();
app.on("before-quit", (event) => {
	if (closing) return;
	event.preventDefault();
	closing = true;
	clearInterval(timer);
	void supervisor
		?.close()
		.catch(console.error)
		.finally(() => app.quit());
});

import { app, BrowserWindow, ipcMain, dialog, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./supervisor";
let window: BrowserWindow;
let supervisor: Supervisor;
let closing = false;
let timer: NodeJS.Timeout;
const testMode = process.env.ORBIT_APP_TEST === "1";
if (testMode && process.env.ORBIT_APP_DATA)
	app.setPath("userData", process.env.ORBIT_APP_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
	window?.show();
	window?.focus();
});
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
		);
		await supervisor.init();
		nativeTheme.themeSource = supervisor.store.state.appearance ?? "system";
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
		const entry = path.join(__dirname, "index.html");
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("will-navigate", (e) => e.preventDefault());
		ipcMain.handle("orbit:call", (event, command, payload) => {
			if (
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				fileURLToPath(event.senderFrame.url) !== entry
			)
				throw new Error("Untrusted IPC sender");
			return supervisor.dispatch(command, payload);
		});
		await window.loadFile(entry);
		timer = setInterval(
			() => void supervisor.tick().catch(console.error),
			15000,
		);
		void supervisor.health();
	} catch (error) {
		dialog.showErrorBox("Orbit App could not open its data", String(error));
		app.exit(1);
	}
}
void start();
app.on("window-all-closed", () => app.quit());
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

import { app, BrowserWindow, ipcMain } from "electron";
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
void app.whenReady().then(async () => {
	supervisor = new Supervisor(app.getPath("userData"), (state) => {
		if (!window?.isDestroyed()) window?.webContents.send("orbit:state", state);
	});
	await supervisor.init();
	window = new BrowserWindow({
		width: 1250,
		height: 840,
		minWidth: 900,
		minHeight: 620,
		title: "Orbit App",
		backgroundColor: "#10151d",
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
			throw Error("Untrusted IPC sender");
		return supervisor.dispatch(command, payload);
	});
	await window.loadFile(entry);
	timer = setInterval(() => void supervisor.tick().catch(console.error), 15000);
	void supervisor.health();
});
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

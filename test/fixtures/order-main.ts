import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { orderFixture, seedOrderFixture } from "./order";

async function start() {
	await app.whenReady();
	const root = process.env.ORBIT_ORDER_ROOT;
	const dist = process.env.ORBIT_ORDER_DIST;
	if (!root || !dist) throw new Error("Missing ordering fixture paths");
	const fixture = orderFixture(root, (state) =>
		window.webContents.send("orbit:state", state),
	);
	const window = new BrowserWindow({
		webPreferences: {
			preload: path.join(dist, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	try {
		await fs.access(path.join(root, "state.json"));
		await fixture.sup.store.init();
	} catch {
		fixture.sup.store.state = seedOrderFixture();
		await fixture.sup.store.save();
	}
	ipcMain.handle("orbit:call", (_e, command, payload) =>
		fixture.sup.dispatch(command, payload),
	);
	(globalThis as any).orderControl = fixture;
	await window.loadFile(path.join(dist, "index.html"));
}
void start();
app.on("window-all-closed", () => app.quit());

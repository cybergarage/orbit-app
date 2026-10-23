import { app, BrowserWindow } from "electron";
const url = process.env.ORBIT_CORE_GUI_URL;
const root = process.env.ORBIT_CORE_GUI_PROFILE;
if (!url || !root) throw new Error("Missing synthetic Core GUI fixture");
app.setPath("userData", root);
const target = url;
void app.whenReady().then(async () => {
	const window = new BrowserWindow({
		width: 1300,
		height: 900,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	await window.loadURL(target);
});
app.on("window-all-closed", () => app.quit());

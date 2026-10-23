import type { App } from "electron";
/** Keep the host scheduler and knowledge queue alive independently of windows. */
export function installBackgroundWindows(
	app: App,
	open: () => Promise<void>,
	quitOnClose = false,
) {
	const reopen = () => {
		void open().catch((error) =>
			console.error("Could not reopen app window", error),
		);
	};
	app.on("activate", reopen);
	app.on("second-instance", reopen);
	app.on("window-all-closed", () => {
		if (quitOnClose) app.quit();
	});
}

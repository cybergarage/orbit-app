import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("orbit", {
	call: (command: string, payload?: unknown) =>
		ipcRenderer.invoke("orbit:call", command, payload),
	subscribe: (callback: (state: unknown) => void) => {
		const listener = (_event: unknown, state: unknown) => callback(state);
		ipcRenderer.on("orbit:state", listener);
		return () => ipcRenderer.removeListener("orbit:state", listener);
	},
});

export interface EventRecord {
	id?: string;
	type: string;
	at: string;
	data: any;
}
export interface DesktopSession {
	id: string;
	name: string;
	events: EventRecord[];
	status: string;
	answer?: string;
}
export interface Project {
	id: string;
	name: string;
	sessions: DesktopSession[];
}
export interface Schedule {
	id: string;
	projectId: string;
	sessionId: string;
	prompt: string;
	model: string;
	nextAt: number;
	intervalMs: number;
	enabled: boolean;
}
export interface Snapshot {
	projects: Project[];
	schedules: Schedule[];
	active?: { projectId: string; sessionId: string; containerName?: string };
	health?: Health;
}
export interface Health {
	docker: boolean;
	ollama: boolean;
	image: boolean;
	models: string[];
	detail: string[];
}
export interface DesktopAPI {
	call(command: string, payload?: any): Promise<any>;
	subscribe(callback: (state: Snapshot) => void): () => void;
}
declare global {
	interface Window {
		orbit: DesktopAPI;
	}
}

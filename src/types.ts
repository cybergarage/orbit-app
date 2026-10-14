export interface EventRecord {
	id?: string;
	type: string;
	at: string;
	data: any;
}
export interface DesktopSession {
	id: string;
	name: string;
	storageProjectId?: string;
	workspace?: string;
	model?: string;
	events: EventRecord[];
	status: string;
	answer?: string;
}
export interface Project {
	id: string;
	name: string;
	directory?: string;
	instructions?: string;
	unassigned?: boolean;
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
export interface Execution {
	id: string;
	scheduleId: string;
	orbitRunId?: string;
	projectId: string;
	sessionId: string;
	projectName: string;
	requestId: string;
	dueAt: number;
	startedAt: number;
	endedAt?: number;
	prompt: string;
	model: string;
	status: string;
	answer?: string;
	events: EventRecord[];
}
export interface Snapshot {
	executions?: Execution[];
	projects: Project[];
	schedules: Schedule[];
	active?: { projectId: string; sessionId: string; containerName?: string };
	health?: Health;
	recoveryBlocked?: boolean;
}
export interface Health {
	checkedAt?: number;
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

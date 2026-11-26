import type { ProviderCatalog } from "./core-models";
import type { SchedulePlan } from "./scheduling";
export interface EventRecord {
	requestId?: string;
	id?: string;
	type: string;
	at: string;
	data: any;
}
export interface DesktopSession {
	archived?: boolean;
	lastUserSubmission?: { at: number; sequence: number };
	autoTitle?: {
		stage: "new" | "pending" | "generating" | "done" | "failed" | "manual";
		generation: number;
		revision?: number;
		prompt?: string;
		model?: string;
		operationId?: string;
	};
	id: string;
	name: string;
	nameRevision?: number;
	storageProjectId?: string;
	workspace?: string;
	model?: string;
	provider?: string;
	events: EventRecord[];
	status: string;
	answer?: string;
}
export interface Project {
	archived?: boolean;
	id: string;
	name: string;
	nameRevision?: number;
	directory?: string;
	instructions?: string;
	unassigned?: boolean;
	sessions: DesktopSession[];
}
export interface Schedule {
	plan?: SchedulePlan;
	creationId?: string;
	creationInput?: string;
	id: string;
	projectId: string;
	sessionId: string;
	prompt: string;
	model: string;
	provider?: string;
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
	provider?: string;
	status: string;
	answer?: string;
	events: EventRecord[];
}
export interface HostRecoveryIdentity {
	version: 1;
	orbitRunId: string;
	storagePairId: string;
	executorOwner: string;
	readerImage: string;
	writerImage?: string;
	readinessImage?: string;
}
export interface HostApprovalAttempt {
	operationId: string;
	approvalId: string;
	digest: string;
}
/** A backend observation, never reconciliation or permission to release a writer. */
export interface HostReadinessReceipt {
	version: 1;
	storagePairId: string;
	sessionId: string;
	orbitRunId: string;
	executorOwner: string;
	image: string;
	containerId: string;
	approval: HostApprovalAttempt;
	outcome: "fixed-probe-exited-zero";
}
export type HostRestartDiagnostic =
	| { journal: "missing" | "unverified" }
	| {
			journal: "open" | "terminal-recorded";
			unresolvedOperations: number;
			readinessReceipt?: "approval-matched" | "unverified";
	  };
export interface Snapshot {
	defaultModel?: { model: string; provider: string };
	maintenance?: { error?: string; complete: boolean };
	submissionSequence?: number;
	appearance?: "system" | "light" | "dark";
	executionBackend?: "host-readonly" | "host-files";
	executionReadinessProbe?: boolean;
	namesVersion?: number;
	executions?: Execution[];
	projects: Project[];
	schedules: Schedule[];
	active?: {
		projectId: string;
		sessionId: string;
		containerName?: string;
		runtime?: "host-v1";
		readerOwner?: string;
		hostRecovery?: HostRecoveryIdentity;
		hostApprovalAttempts?: HostApprovalAttempt[];
		hostReadinessReceipt?: HostReadinessReceipt;
		workspaceMutations?: boolean;
		workspaceReads?: boolean;
		workspaceReadiness?: boolean;
	};
	health?: Health;
	recoveryBlocked?: boolean;
	/** A fresh host observation, not persisted recovery authority. */
	recoveryBlockReason?: "host-writer-retained";
	/** Read-only, snapshot-only Core observation; never recovery authority. */
	hostRestartDiagnostic?: HostRestartDiagnostic;
}
export interface Health {
	catalog?: ProviderCatalog;
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

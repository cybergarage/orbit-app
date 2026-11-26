import { hostOriginator, hostRepository } from "./host-core";
import type {
	HostRecoveryIdentity,
	HostRestartDiagnostic,
	Snapshot,
} from "./types";

const ownerName = /^orbit-app-[a-f0-9-]{36}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const hexId = /^[a-f0-9]{64}$/;

function scopedReadinessReceipt(
	active: NonNullable<Snapshot["active"]>,
	saved: HostRecoveryIdentity,
) {
	const receipt = active.hostReadinessReceipt;
	if (
		receipt?.version !== 1 ||
		receipt.outcome !== "fixed-probe-exited-zero" ||
		active.workspaceReadiness !== true ||
		receipt.sessionId !== active.sessionId ||
		receipt.storagePairId !== saved.storagePairId ||
		receipt.orbitRunId !== saved.orbitRunId ||
		receipt.executorOwner !== saved.executorOwner ||
		receipt.image !== saved.readinessImage ||
		typeof receipt.containerId !== "string" ||
		!hexId.test(receipt.containerId) ||
		!receipt.approval ||
		!Array.isArray(active.hostApprovalAttempts)
	)
		return undefined;

	const { approvalId, digest, operationId } = receipt.approval;
	const attempts = active.hostApprovalAttempts.filter(
		(attempt) =>
			attempt?.approvalId === approvalId ||
			attempt?.operationId === operationId,
	);
	const [attempt] = attempts;
	if (
		attempts.length !== 1 ||
		attempt?.approvalId !== approvalId ||
		attempt?.operationId !== operationId ||
		attempt?.digest !== digest
	)
		return undefined;
	return {
		pairId: receipt.storagePairId,
		sessionId: receipt.sessionId,
		runId: receipt.orbitRunId,
		approvalId,
		digest,
		operationId,
	};
}

/** Observation only. Does not acquire a writer, verify effects or grant recovery. */
export async function inspectHostRestart(
	active: NonNullable<Snapshot["active"]>,
	location: { core: string; workspace: string },
): Promise<HostRestartDiagnostic> {
	const unverified = { journal: "unverified" } as const;
	const saved = active.hostRecovery;
	if (
		active.runtime !== "host-v1" ||
		active.containerName ||
		saved?.version !== 1 ||
		!active.readerOwner ||
		!ownerName.test(active.readerOwner) ||
		saved.executorOwner !== active.readerOwner ||
		!imageId.test(saved.readerImage) ||
		(active.workspaceMutations === true) !== Boolean(saved.writerImage) ||
		(active.workspaceReadiness === true) !== Boolean(saved.readinessImage) ||
		(saved.writerImage !== undefined && !imageId.test(saved.writerImage)) ||
		(saved.readinessImage !== undefined && !imageId.test(saved.readinessImage))
	)
		return unverified;
	try {
		const repo = await hostRepository(location.core);
		const found = await repo.findById(active.sessionId);
		if (
			found?.originator !== hostOriginator ||
			found.cwd !== location.workspace
		)
			return unverified;
		const scope = repo.scope(active.sessionId);
		if (scope.pairId !== saved.storagePairId) return unverified;
		const { inspectRestartRun, verifyRestartCommandApproval } = await import(
			"@cybergarage/orbit"
		);
		const report = inspectRestartRun(scope, saved.orbitRunId);
		if (
			report.pairId !== saved.storagePairId ||
			report.sessionId !== active.sessionId ||
			report.runId !== saved.orbitRunId ||
			!report.writerRetained
		)
			return unverified;
		if (report.journal !== "open" && report.journal !== "terminal-recorded")
			return { journal: report.journal };
		// Absence remains distinct from a retained receipt which could not be matched.
		const binding = scopedReadinessReceipt(active, saved);
		const receiptStatus =
			binding && verifyRestartCommandApproval(scope, binding) === "matched"
				? "approval-matched"
				: "unverified";
		return {
			...(active.hostReadinessReceipt !== undefined
				? { readinessReceipt: receiptStatus }
				: {}),
			journal: report.journal,
			unresolvedOperations: report.unresolvedOperationIds.length,
		};
	} catch {
		return unverified;
	}
}

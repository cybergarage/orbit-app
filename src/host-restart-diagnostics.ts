import { hostOriginator, hostRepository } from "./host-core";
import type { HostRestartDiagnostic, Snapshot } from "./types";

const ownerName = /^orbit-app-[a-f0-9-]{36}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;

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
		const { inspectRestartRun } = await import("@cybergarage/orbit");
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
		return {
			journal: report.journal,
			unresolvedOperations: report.unresolvedOperationIds.length,
		};
	} catch {
		return unverified;
	}
}

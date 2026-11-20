// The opt-in must fail closed with a stale Core or a WorkspaceExecutor
// implementation that would route every managed built-in.
export async function createWorkspaceMutationExecutor(rpc, capture) {
	if (!capture) {
		const packageApi = await import(
			"@cybergarage/orbit/dist/core/execution/workspace-executor.js"
		).catch(() => {
			throw new Error(
				"Docker workspace mutations require Core selective workspace routing",
			);
		});
		capture = packageApi.captureWorkspaceExecutor;
	}
	const requested = {
		toolNames: Object.freeze(["write", "edit"]),
		execute: (operation, signal) =>
			rpc("workspace-mutation", operation, signal),
	};
	const configured = capture?.(requested);
	if (
		configured?.toolNames?.length !== 2 ||
		configured.toolNames[0] !== "write" ||
		configured.toolNames[1] !== "edit"
	)
		throw new Error(
			"Docker workspace mutations require Core selective workspace routing",
		);
	return configured;
}

// The opt-in must fail closed with a stale Core or a WorkspaceExecutor
// implementation that would route every managed built-in.
export async function createWorkspaceMutationExecutor(
	rpc,
	capture,
	options = { mutations: true },
) {
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
	const names = Object.freeze([
		...(options.mutations ? ["write", "edit"] : []),
		...(options.reads ? ["read", "list", "glob", "grep"] : []),
	]);
	const requested = {
		toolNames: names,
		execute: (operation, signal) =>
			rpc(
				operation.effect === "read" && options.reads
					? "workspace-observation"
					: "workspace-mutation",
				operation,
				signal,
			),
	};
	const configured = capture?.(requested);
	if (
		configured?.toolNames?.length !== names.length ||
		configured.toolNames.some((name, index) => name !== names[index])
	)
		throw new Error(
			"Docker workspace mutations require Core selective workspace routing",
		);
	return configured;
}

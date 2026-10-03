// Conservative prototype search syntax avoids braces' recursive parser surfaces.
export function safePatterns(value) {
	const patterns =
		value === undefined ? ["**/*"] : Array.isArray(value) ? value : [value];
	return (
		patterns.length > 0 &&
		patterns.length <= 16 &&
		patterns.every(
			(pattern) =>
				typeof pattern === "string" &&
				pattern.length <= 2048 &&
				!/[{}()[\]\\]/.test(pattern),
		)
	);
}
export function decideOperation(operation) {
	if (operation.name === "glob" && !safePatterns(operation.input?.pattern))
		return "deny";
	if (operation.name === "grep" && !safePatterns(operation.input?.glob))
		return "deny";
	return operation.effect === "read" ? "allow" : "ask";
}

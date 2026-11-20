import path from "node:path";

const effects = {
	bash: "command",
	edit: "write",
	glob: "read",
	grep: "read",
	list: "read",
	read: "read",
	write: "write",
} as const;
type WorkspaceTool = keyof typeof effects;

const inputFields: Record<WorkspaceTool, readonly string[]> = {
	bash: ["command", "timeoutSeconds"],
	edit: ["path", "oldText", "newText", "replaceAll"],
	glob: ["path", "pattern", "limit", "includeHidden", "includeDirectories"],
	grep: [
		"path",
		"pattern",
		"glob",
		"limit",
		"contextLines",
		"ignoreCase",
		"literal",
	],
	list: ["path", "limit", "includeHidden"],
	read: ["path", "limit", "offset"],
	write: ["path", "content", "createDirectories"],
};

function safeValue(value: unknown) {
	return (
		value === undefined ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

/** Wire subset of Core's versioned prepared operation; never accepts run state. */
interface Operation {
	version: 1;
	name: WorkspaceTool;
	effect: (typeof effects)[WorkspaceTool];
	cwd: string;
	target: string;
	input: Readonly<Record<string, unknown>>;
	preimageSha256?: string | null;
	resultSha256?: string;
}

function mapPath(workspace: string, target: string) {
	if (
		!path.isAbsolute(target) ||
		path.resolve(target) !== target ||
		/[\\\0]/.test(target)
	)
		throw new Error("Workspace target is not normalized");
	const relative = path.relative(workspace, target);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error("Workspace target is outside the bound workspace");
	return path.posix.join("/workspace", ...relative.split(path.sep));
}

function sha256(value: unknown) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Translate only Core-approved paths. Worker validates again at execution. */
export function encodeWorkspaceRequest(
	workspace: string,
	operation: Operation,
): string {
	if (
		!path.isAbsolute(workspace) ||
		path.resolve(workspace) !== workspace ||
		!Object.hasOwn(effects, operation.name) ||
		operation.version !== 1 ||
		effects[operation.name] !== operation.effect
	)
		throw new Error("Invalid prepared workspace operation");
	const cwd = mapPath(workspace, operation.cwd);
	const target = mapPath(workspace, operation.target);
	const fields = inputFields[operation.name];
	const input = Object.fromEntries(
		Object.entries(operation.input).map(([key, value]) => {
			if (!fields.includes(key) || !safeValue(value))
				throw new Error("Invalid prepared workspace input");
			return [key, value];
		}),
	);
	if (operation.name === "bash") {
		if (target !== cwd || Object.hasOwn(input, "path"))
			throw new Error("Prepared Bash must use its bound working directory");
	} else {
		if (input.path !== operation.target)
			throw new Error("Prepared workspace input and target disagree");
		input.path = target;
	}
	if (
		operation.effect === "write" &&
		(!sha256(operation.resultSha256) ||
			(operation.preimageSha256 !== null && !sha256(operation.preimageSha256)))
	)
		throw new Error("Prepared mutation is missing its digest");
	const request = JSON.stringify({
		version: 1,
		name: operation.name,
		effect: operation.effect,
		cwd,
		target,
		input,
		...(operation.effect === "write"
			? {
					preimageSha256: operation.preimageSha256,
					resultSha256: operation.resultSha256,
				}
			: {}),
	});
	if (Buffer.byteLength(request) > 1024 * 1024)
		throw new Error("Workspace request exceeds byte limit");
	return request;
}

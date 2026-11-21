import type { ToolResult } from "@cybergarage/orbit";
import { spawn } from "node:child_process";
import { encodeWorkspaceRequest } from "./workspace-request";

const ownerLabel = "org.cybergarage.orbit-app.workspace-parent";
const controlDeadline = 5_000;
const executionDeadline = 15_000;
const replyLimit = 16_384;
const observationReplyLimit = 1024 * 1024;
const observationDeadline = 12_000;
const uncertain = () =>
	new Error("Workspace mutation outcome unknown; do not replay");

type Command = (
	exe: string,
	args: string[],
	timeout: number,
) => Promise<string>;
type Attached = (
	exe: string,
	id: string,
	message: string,
	signal: AbortSignal,
) => Promise<unknown>;
export interface MutationPorts {
	docker: string;
	args(name: string, workspace: string): string[];
	command: Command;
	attached?: Attached;
}

function childName(parent: string, observation = false): string {
	const id = /^orbit-app-([a-f0-9-]{36})$/.exec(parent)?.[1];
	if (!id) throw new Error("Invalid workspace mutation owner");
	return `orbit-app-workspace-${id}${observation ? "-read" : ""}`;
}

/** An already durable parent ID determines the only child this run may reap. */
export async function stopWorkspaceMutation(
	parent: string,
	ports: MutationPorts,
	observation = false,
) {
	const { docker, command } = ports;
	const name = childName(parent, observation);
	const find = () =>
		command(
			docker,
			["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
			controlDeadline,
		);
	if (!(await find()).trim()) return;
	const owner = await command(
		docker,
		["inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, name],
		controlDeadline,
	);
	if (owner.trim() !== parent)
		throw new Error("Workspace mutation ownership mismatch");
	await command(docker, ["rm", "-f", name], controlDeadline).catch(() => {});
	if ((await find()).trim())
		throw new Error("Workspace mutation stop not confirmed");
}

function acknowledged(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw uncertain();
	const result = value as Record<string, unknown>;
	if (
		Object.keys(result).some((key) => key !== "content" && key !== "isError") ||
		(result.isError !== undefined && result.isError !== true) ||
		!Array.isArray(result.content) ||
		result.content.length !== 1
	)
		throw uncertain();
	const [part] = result.content;
	if (
		part?.type !== "text" ||
		typeof part.text !== "string" ||
		Object.keys(part).some((key) => key !== "text" && key !== "type") ||
		Buffer.byteLength(part.text) > 4096
	)
		throw uncertain();
	return {
		content: [{ type: "text", text: part.text }],
		...(result.isError ? { isError: true } : {}),
	};
}

const startAttached = (
	docker: string,
	id: string,
	message: string,
	signal: AbortSignal,
	deadline = executionDeadline,
	maxBytes = replyLimit,
): Promise<unknown> =>
	new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const child = spawn(docker, ["start", "--attach", "--interactive", id], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		const abort = () => {
			child.kill("SIGKILL");
			reject(uncertain());
		};
		const timer = setTimeout(abort, deadline);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) abort();
			else chunks.push(chunk);
		});
		child.once("error", abort);
		child.once("close", (code) => {
			cleanup();
			if (code !== 0 || signal.aborted) {
				reject(uncertain());
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(uncertain());
			}
		});
		child.stdin.end(message);
	});

export async function executeWorkspaceMutation(
	parent: string,
	workspace: string,
	operation: Parameters<typeof encodeWorkspaceRequest>[1],
	signal: AbortSignal,
	ports: MutationPorts,
) {
	signal.throwIfAborted();
	if (operation.name !== "write" && operation.name !== "edit")
		throw new Error("Only prepared writes and edits may use this route");
	const frame = encodeWorkspaceRequest("/workspace", operation);
	const args = ports.args(childName(parent), workspace);
	args[0] = "create";
	args.splice(args.length - 1, 0, "--label", `${ownerLabel}=${parent}`);
	try {
		const id = (
			await ports.command(ports.docker, args, controlDeadline)
		).trim();
		if (!/^[0-9a-f]{64}$/.test(id)) throw uncertain();
		signal.throwIfAborted();
		const result = await (ports.attached ?? startAttached)(
			ports.docker,
			id,
			frame,
			signal,
		);
		signal.throwIfAborted();
		return acknowledged(result);
	} finally {
		await stopWorkspaceMutation(parent, ports);
	}
}

function observationError(): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: "Workspace observation failed or exceeded its limits",
			},
		],
		isError: true,
	};
}

function observationAcknowledged(
	value: unknown,
	tool: string,
): value is ToolResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const answer = value as Record<string, unknown>;
	if (
		Object.keys(answer).some(
			(key) => !["content", "details", "isError"].includes(key),
		) ||
		!Array.isArray(answer.content) ||
		answer.content.length !== 1 ||
		(answer.isError !== undefined && answer.isError !== true) ||
		Buffer.byteLength(JSON.stringify(answer)) > observationReplyLimit
	)
		return false;
	const [part] = answer.content;
	if (
		part?.type !== "text" ||
		typeof part.text !== "string" ||
		Object.keys(part).some((key) => !["type", "text"].includes(key))
	)
		return false;
	if (answer.isError === true) return answer.details === undefined;
	if (
		!answer.details ||
		typeof answer.details !== "object" ||
		Array.isArray(answer.details)
	)
		return false;
	const detail = answer.details as Record<string, unknown>;
	const nonnegative = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
	const outputPath = (v: unknown) =>
		typeof v === "string" &&
		(v === "/workspace" || v.startsWith("/workspace/")) &&
		!v.split("/").includes("..");
	const exact = (record: unknown, keys: string[]) =>
		Boolean(
			record &&
				typeof record === "object" &&
				!Array.isArray(record) &&
				Object.keys(record).length === keys.length &&
				Object.keys(record).every((key) => keys.includes(key)),
		);
	if (typeof detail.truncated !== "boolean") return false;
	switch (tool) {
		case "read":
			return (
				exact(detail, [
					"encoding",
					"path",
					"startLine",
					"endLine",
					"totalLines",
					"truncated",
				]) &&
				detail.encoding === "utf8" &&
				outputPath(detail.path) &&
				[detail.startLine, detail.endLine, detail.totalLines].every(nonnegative)
			);
		case "list":
			return (
				exact(detail, ["path", "entries", "omitted", "truncated"]) &&
				outputPath(detail.path) &&
				nonnegative(detail.omitted) &&
				Array.isArray(detail.entries) &&
				detail.entries.every(
					(e) =>
						exact(e, ["name", "kind"]) &&
						typeof e.name === "string" &&
						["directory", "file", "other", "symlink"].includes(e.kind),
				)
			);
		case "glob":
			return (
				exact(detail, ["matches", "omitted", "truncated"]) &&
				nonnegative(detail.omitted) &&
				Array.isArray(detail.matches) &&
				detail.matches.every(outputPath)
			);
		case "grep":
			return (
				exact(detail, ["matches", "truncated"]) &&
				Array.isArray(detail.matches) &&
				detail.matches.every(
					(m) =>
						exact(m, [
							"line",
							"column",
							"path",
							"text",
							...(m?.context ? ["context"] : []),
						]) &&
						nonnegative(m.line) &&
						nonnegative(m.column) &&
						outputPath(m.path) &&
						typeof m.text === "string" &&
						(m.context === undefined ||
							(Array.isArray(m.context) &&
								m.context.every(
									(c: any) =>
										exact(c, ["line", "text"]) &&
										nonnegative(c.line) &&
										typeof c.text === "string",
								))),
				)
			);
		default:
			return false;
	}
}

export async function executeWorkspaceObservation(
	parent: string,
	workspace: string,
	operation: Parameters<typeof encodeWorkspaceRequest>[1],
	signal: AbortSignal,
	ports: MutationPorts,
	sourceWorkspace = "/workspace",
) {
	if (signal.aborted) return observationError();
	let frame: string;
	try {
		if (
			operation.effect !== "read" ||
			!["read", "list", "glob", "grep"].includes(operation.name)
		)
			return observationError();
		frame = encodeWorkspaceRequest(sourceWorkspace, operation);
		if (Buffer.byteLength(frame) > 32 * 1024) return observationError();
	} catch {
		return observationError();
	}
	try {
		const args = ports.args(childName(parent, true), workspace);
		args[0] = "create";
		args.splice(1, 0, "--label", `${ownerLabel}=${parent}`);
		const id = (
			await ports.command(ports.docker, args, controlDeadline)
		).trim();
		if (!/^[0-9a-f]{64}$/.test(id)) return observationError();
		signal.throwIfAborted();
		const start =
			ports.attached ??
			((docker, cid, message, abort) =>
				startAttached(
					docker,
					cid,
					message,
					abort,
					observationDeadline,
					observationReplyLimit,
				));
		const value = await start(ports.docker, id, frame, signal);
		return !signal.aborted && observationAcknowledged(value, operation.name)
			? value
			: observationError();
	} catch {
		// This lane cannot mutate. Once verified gone, a failed/expired reply is
		// a settled tool error, not an unknown write nor a fallback.
		return observationError();
	} finally {
		await stopWorkspaceMutation(parent, ports, true);
	}
}

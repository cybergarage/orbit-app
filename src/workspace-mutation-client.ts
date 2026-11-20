import { spawn } from "node:child_process";
import { encodeWorkspaceRequest } from "./workspace-request";

const ownerLabel = "org.cybergarage.orbit-app.workspace-parent";
const controlDeadline = 5_000;
const executionDeadline = 15_000;
const replyLimit = 16_384;
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

function childName(parent: string): string {
	const id = /^orbit-app-([a-f0-9-]{36})$/.exec(parent)?.[1];
	if (!id) throw new Error("Invalid workspace mutation owner");
	return `orbit-app-workspace-${id}`;
}

/** An already durable parent ID determines the only child this run may reap. */
export async function stopWorkspaceMutation(
	parent: string,
	ports: MutationPorts,
) {
	const { docker, command } = ports;
	const name = childName(parent);
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

const startAttached: Attached = (docker, id, message, signal) =>
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
		const timer = setTimeout(abort, executionDeadline);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > replyLimit) abort();
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

import path from "node:path";
import { createHash } from "node:crypto";
import { command, dockerPath, image } from "./worker";
const states = new Map<string, { active: number; ready?: Promise<string> }>();
function identity(root: string) {
	return `orbit-app-source-owner-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}`;
}
export function sourceProfileRoot(core: string) {
	if (
		path.basename(core) !== "core" ||
		path.basename(path.dirname(path.dirname(core))) !== "projects"
	)
		throw new Error(
			"Source helpers require an App-owned original core directory",
		);
	return path.dirname(path.dirname(path.dirname(core)));
}
async function ensure(root: string): Promise<string> {
	const name = identity(root);
	const list = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`name=^/${name}$`,
		"--format",
		"{{.Names}}",
	]);
	if (!list.trim())
		await command(dockerPath, [
			"run",
			"--rm",
			"-d",
			"--pull=never",
			"--name",
			name,
			"--label",
			`org.cybergarage.orbit-app.source-profile=${path.resolve(root)}`,
			"--network",
			"none",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"256",
			"--memory",
			"128m",
			"--cpus",
			"0.1",
			"--entrypoint",
			"node",
			image,
			"-e",
			"setInterval(() => {}, 60000)",
		]);
	const owner = await command(dockerPath, [
		"inspect",
		"--format",
		'{{index .Config.Labels "org.cybergarage.orbit-app.source-profile"}}',
		name,
	]);
	if (owner.trim() !== path.resolve(root))
		throw new Error("Source namespace belongs to another profile");
	const running = await command(dockerPath, [
		"inspect",
		"--format",
		"{{.State.Running}}",
		name,
	]);
	if (running.trim() !== "true")
		throw new Error(
			"Source namespace is not running; preserve ownership evidence and review recovery",
		);
	return name;
}
/** PID 1 owns no session claim. Only source helpers share this isolated namespace. */
export async function holdSourceNamespace(root: string) {
	root = path.resolve(root);
	const state = states.get(root) ?? { active: 0 };
	states.set(root, state);
	state.active++;
	try {
		state.ready ??= ensure(root);
		const name = await state.ready;
		let released = false;
		return {
			name,
			release() {
				if (!released) {
					state.active--;
					released = true;
				}
			},
		};
	} catch (error) {
		state.active--;
		state.ready = undefined;
		throw error;
	}
}
export async function closeSourceNamespace(root: string) {
	root = path.resolve(root);
	const state = states.get(root);
	if (!state?.ready) return;
	if (state.active)
		throw new Error(
			"Source namespace still owns active or uncertain helper work",
		);
	const name = await state.ready;
	const owner = await command(dockerPath, [
		"inspect",
		"--format",
		'{{index .Config.Labels "org.cybergarage.orbit-app.source-profile"}}',
		name,
	]);
	if (owner.trim() !== root)
		throw new Error("Source namespace ownership changed; shutdown refused");
	await command(dockerPath, ["stop", "--time", "5", name]);
	states.delete(root);
}

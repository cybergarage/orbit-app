import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
// This pinned published module contains only the filesystem maintenance implementation.
// Bundling this module avoids loading provider/CLI/native SQLite code into Electron.
import {
	planInitialization,
	executeInitialization,
	type InitializationPlan,
} from "@cybergarage/orbit/dist/core/maintenance/initialization.js";
import { canonicalStoragePath } from "@cybergarage/orbit/dist/core/session/storage-registration.js";
import type {
	InitializationMode,
	InitializationPreview,
} from "./initialization";
import { containerMaintenance } from "./maintenance-container";
import { command, dockerPath } from "./worker";
import { parseAppJson, assertAppProfileRoot, type Store } from "./store";

const registryFields = new Set([
	"namesVersion",
	"projects",
	"schedules",
	"executions",
	"submissionSequence",
	"active",
	"recoveryBlocked",
]);
const offlineConsent = {
	confirmation: "INITIALIZE" as const,
	allWritersStopped: true as const,
	automaticRestartersDisabled: true as const,
	exclusiveStorageControl: true as const,
};
const consentFields = [
	"allWritersStopped",
	"automaticRestartersDisabled",
	"exclusiveStorageControl",
] as const;
const contains = (a: string, b: string) =>
	b === a || b.startsWith(`${a}${path.sep}`);
async function exists(file: string) {
	try {
		return await fs.lstat(file);
	} catch (e: any) {
		if (e.code !== "ENOENT") throw e;
	}
}
const appleVmExecutable =
	"/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine";
async function verifiedReadOnlyVm(pid: string) {
	if (process.platform !== "darwin" || !/^\d+$/.test(pid)) return false;
	try {
		const executable = (
			await command("/bin/ps", ["-p", pid, "-o", "comm="])
		).trim();
		if (executable !== appleVmExecutable) return false;
		await command("/usr/bin/codesign", [
			"--verify",
			"--strict",
			"--test-requirement",
			'=anchor apple and identifier "com.apple.Virtualization.VirtualMachine"',
			appleVmExecutable,
		]);
		return true;
	} catch {
		return false;
	}
}
async function allowDirectory(directory: string, names: string[]) {
	const info = await exists(directory);
	if (!info) return;
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Unsafe App directory: ${directory}`);
	for (const entry of await fs.readdir(directory))
		if (!names.includes(entry))
			throw new Error(
				`Unknown object retained; initialization refuses this directory: ${path.join(directory, entry)}`,
			);
}
function storageHandles(output: string) {
	const handles: { pid: string; access?: string; type?: string }[] = [];
	let pid = "";
	let handle: (typeof handles)[number] | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			pid = line.slice(1);
			handle = undefined;
		}
		if (line.startsWith("f")) {
			handle = { pid };
			handles.push(handle);
		}
		if (line.startsWith("a") && handle) handle.access = line.slice(1);
		if (line.startsWith("t") && handle) handle.type = line.slice(1);
	}
	return handles;
}
async function assertNoWritableHandles(target: string) {
	const info = await exists(target);
	if (!info) return;
	const output = await new Promise<string>((resolve, reject) => {
		execFile(
			process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
			info.isDirectory() ? ["-Ffat", "+D", target] : ["-Ffat", "--", target],
			{ timeout: 15000, maxBuffer: 128000 },
			(error, stdout, stderr) => {
				if (stderr.trim() || (error && error.code !== 1))
					return reject(
						new Error(
							`Cannot verify external storage handles: ${target} (${error?.code ?? "stderr"}; ${stderr.trim().slice(0, 1500)})`,
						),
					);
				resolve(stdout);
			},
		);
	});
	if (!output.trim()) return;
	const handles = storageHandles(output);
	if (!handles.length)
		throw new Error(`Unclassified storage handles remain: ${target}`);
	// Container writers/restarters are excluded first. Only the signed Apple VM
	// gets the read-only REG cache exemption; ordinary readers still refuse.
	for (const h of handles) {
		if (h.access !== "r")
			throw new Error(`Open storage handles remain: ${target}`);
		if (h.type === "DIR") continue;
		if (h.type === "REG" && (await verifiedReadOnlyVm(h.pid))) continue;
		throw new Error(`Open storage handles remain: ${target}`);
	}
}

export async function assertExternalWritersStopped(
	root: string,
	targets: string[],
) {
	root = await fs.realpath(root);
	// Inspect mount sources and restart policy only; never retrieve container environments.
	const ids = (await command(dockerPath, ["ps", "-aq"]))
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (ids.length > 256)
		throw new Error(
			"Container inventory is too large to verify exclusive storage control",
		);
	for (const id of ids) {
		const info = JSON.parse(
			await command(dockerPath, [
				"inspect",
				"--format",
				'{"mounts":{{json .Mounts}},"running":{{.State.Running}},"restart":{{json .HostConfig.RestartPolicy}}}',
				id,
			]),
		);
		if (
			(info.running || !["", "no"].includes(info.restart.Name)) &&
			info.mounts.some(
				(m: any) =>
					typeof m.Source === "string" &&
					(contains(root, m.Source) || contains(m.Source, root)),
			)
		)
			throw new Error(
				"A container writer or automatic restarter still owns App storage; stop it before initialization",
			);
	}
	for (const target of targets) await assertNoWritableHandles(target);
}

interface Part {
	core: string;
	plan: InitializationPlan;
}
interface CompletePlan {
	id: string;
	mode: InitializationMode;
	includeSettings: boolean;
	root: InitializationPlan;
	parts: Part[];
	retained: string[];
}
export class AppInitialization {
	private finalPlan?: CompletePlan;
	private busy = false;
	completed = false;
	constructor(
		private store: Store,
		private helper = containerMaintenance,
		private external = assertExternalWritersStopped,
	) {}
	get marker() {
		return path.join(this.store.root, "initialization-maintenance.json");
	}
	async readMarker(): Promise<
		| {
				phase: string;
				error?: string;
				mode?: InitializationMode;
				includeSettings?: boolean;
		  }
		| undefined
	> {
		const info = await exists(this.marker);
		if (!info) return;
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
			throw new Error("Unsafe maintenance record; keep storage unchanged");
		const value = parseAppJson(await fs.readFile(this.marker, "utf8"));
		if (
			!value ||
			!["stopping", "stopped", "executing", "failed", "complete"].includes(
				value.phase,
			) ||
			Object.keys(value).some(
				(k) => !["phase", "error", "mode", "includeSettings"].includes(k),
			) ||
			(value.mode !== undefined &&
				!["settings", "data", "all"].includes(value.mode)) ||
			(value.includeSettings !== undefined &&
				typeof value.includeSettings !== "boolean") ||
			(value.mode === undefined) !== (value.includeSettings === undefined) ||
			(value.error !== undefined && typeof value.error !== "string")
		)
			throw new Error("Unknown maintenance record; keep storage unchanged");
		return value;
	}
	async mark(
		phase: string,
		error?: string,
		scope?: { mode: InitializationMode; includeSettings: boolean },
	) {
		await assertAppProfileRoot(this.store.root);
		const previous = await this.readMarker();
		const pendingScope =
			scope ??
			(previous?.mode
				? { mode: previous.mode, includeSettings: previous.includeSettings }
				: {});
		const temporary = path.join(
			this.store.root,
			`.initialization-control-${randomUUID()}.tmp`,
		);
		try {
			await fs.writeFile(
				temporary,
				JSON.stringify({ phase, error, ...pendingScope }),
				{
					mode: 0o600,
					flag: "wx",
				},
			);
			await fs.rename(temporary, this.marker);
		} finally {
			await fs.unlink(temporary).catch((e) => {
				if (e.code !== "ENOENT") throw e;
			});
		}
	}

	private async plan(
		mode: InitializationMode,
		includeSettings: boolean,
	): Promise<CompletePlan> {
		if (!["settings", "data", "all"].includes(mode))
			throw new Error("Invalid initialization mode");
		if (mode !== "data" && includeSettings !== true)
			throw new Error(
				"Explicitly select App settings before reviewing this scope",
			);
		includeSettings = mode !== "data" && includeSettings === true;
		const root = this.store.root;
		const canonical = await fs.realpath(root);
		if (
			(await fs.lstat(root)).isSymbolicLink() ||
			/[,\r\n]/.test(root) ||
			[os.homedir(), path.parse(root).root].includes(canonical) ||
			contains(path.join(os.homedir(), ".orbit"), canonical)
		)
			throw new Error("Unsafe or shared initialization profile");
		if (await exists(path.join(root, "state.json")))
			throw new Error(
				"Legacy registry remains; restart normally before planning initialization",
			);
		const retained = [
			"Working files and external workspaces",
			"Shared skills, AGENTS.md and ORBIT.md",
			"Environment credentials, Docker images and Ollama models",
			"Unknown objects and Electron browser profile/cache",
		];
		const preserved = [path.join(os.homedir(), ".orbit")];
		const cores: string[] = [];
		const projectsRoot = path.join(root, "projects");
		const projectsInfo = await exists(projectsRoot);
		if (projectsInfo) {
			if (projectsInfo.isSymbolicLink() || !projectsInfo.isDirectory())
				throw new Error("Unsafe project registry root");
			for (const id of (await fs.readdir(projectsRoot)).sort()) {
				if (!/^[a-f0-9-]{36}$/.test(id)) {
					retained.push(path.join(projectsRoot, id));
					continue;
				}
				const projectRoot = path.join(projectsRoot, id);
				if ((await fs.lstat(projectRoot)).isSymbolicLink())
					throw new Error("Unsafe project directory");
				preserved.push(path.join(projectRoot, "workspace"));
				const core = path.join(projectRoot, "core");
				const info = await exists(core);
				if (info) {
					if (info.isSymbolicLink() || !info.isDirectory())
						throw new Error("Unsafe core directory");
					cores.push(core);
				}
			}
		}
		for (const p of this.store.state.projects) {
			if (p.directory) preserved.push(p.directory);
			for (const s of p.sessions) if (s.workspace) preserved.push(s.workspace);
		}
		if (mode !== "settings") {
			await allowDirectory(path.join(root, "registry"), [
				"state.json",
				"state.json.tmp",
			]);
			await allowDirectory(path.join(root, "catalog"), [
				"projects.sqlite",
				"projects.sqlite-wal",
				"projects.sqlite-shm",
				"projects.sqlite-journal",
			]);
			for (const file of ["state.json", "state.json.tmp"]) {
				const target = path.join(root, "registry", file);
				if (await exists(target)) {
					const saved = parseAppJson(await fs.readFile(target, "utf8"));
					if (Object.keys(saved).some((k) => !registryFields.has(k)))
						throw new Error(
							"Unknown saved-data fields retained; initialization requires review",
						);
				}
			}
		}
		if (mode !== "data") {
			if (await exists(path.join(root, "settings.json.tmp")))
				throw new Error(
					"Unfinished settings write; keep storage offline and inspect before resetting",
				);
			const settings = await fs
				.readFile(path.join(root, "settings.json"), "utf8")
				.then(parseAppJson)
				.catch((e) => {
					if (e.code !== "ENOENT") throw e;
					return {};
				});
			if (Object.keys(settings).some((k) => k !== "appearance"))
				throw new Error(
					"Unknown settings fields retained; initialization requires review",
				);
		}
		const hostPlan = planInitialization(
			{
				ownedRoots: [root],
				preservedPaths: preserved,
				stores: [],
				settingsFiles:
					includeSettings && mode !== "data"
						? [path.join(root, "settings.json")]
						: [],
				scheduledRoots: [
					path.join(root, "registry"),
					path.join(root, "catalog"),
				],
				cacheRoots: [
					path.join(root, "cache", "health.json"),
					path.join(root, "cache", "health.json.tmp"),
				],
			},
			mode,
		);
		const parts: Part[] = [];
		if (mode !== "settings")
			for (const core of cores)
				parts.push({ core, plan: await this.helper(core, { action: "plan" }) });
		for (const part of parts) {
			for (const target of part.plan.targets) {
				const hostTarget = canonicalStoragePath(
					path.join(part.core, path.relative("/state", target.path)),
				);
				if (
					preserved.some((item) => {
						const workspace = canonicalStoragePath(item);
						return (
							contains(hostTarget, workspace) || contains(workspace, hostTarget)
						);
					})
				)
					throw new Error(
						"Working files overlap a registered storage target; retain storage and review the profile offline",
					);
			}
		}
		const body = { mode, includeSettings, root: hostPlan, parts, retained };
		return {
			...body,
			id: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
		};
	}
	private display(plan: CompletePlan, final: boolean): InitializationPreview {
		return {
			id: plan.id,
			mode: plan.mode,
			final,
			targets: [
				...plan.parts.flatMap(({ core, plan: p }) =>
					p.targets.map((t) => ({
						...t,
						path: path.join(core, path.relative("/state", t.path)),
					})),
				),
				...plan.root.targets,
			].map(({ path: file, kind, files, bytes }) => ({
				path: file,
				kind,
				files,
				bytes,
			})),
			retained: [...plan.retained, ...plan.root.profile.preservedPaths],
		};
	}
	get finalPreview() {
		return this.finalPlan ? this.display(this.finalPlan, true) : undefined;
	}
	async preview(mode: InitializationMode, includeSettings: boolean) {
		return this.display(await this.plan(mode, includeSettings), false);
	}
	async review(mode: InitializationMode, includeSettings: boolean) {
		if (this.busy || this.completed)
			throw new Error("Initialization is already running or completed");
		this.finalPlan = undefined;
		const pending = await this.readMarker();
		if (
			pending?.mode &&
			pending.phase !== "complete" &&
			mode !== pending.mode &&
			mode !== "all"
		)
			throw new Error(
				"Incomplete initialization scope cannot be narrowed; retry the original scope or all App data and settings",
			);
		const plan = await this.plan(mode, includeSettings);
		await this.external(
			this.store.root,
			this.display(plan, true).targets.map((t) => t.path),
		);
		for (const part of plan.parts)
			await this.helper(part.core, {
				action: "verify",
				consent: offlineConsent,
			});
		this.finalPlan = plan;
		return this.display(plan, true);
	}
	async execute(input: any) {
		if (this.busy || this.completed)
			throw new Error("Initialization already running or completed");
		const plan = this.finalPlan;
		if (
			!plan ||
			input.planId !== plan.id ||
			input.confirmation !== "INITIALIZE" ||
			consentFields.some((k) => input[k] !== true)
		)
			throw new Error(
				"Final plan, INITIALIZE and every offline declaration are required",
			);
		this.busy = true;
		this.finalPlan = undefined;
		const completed: string[] = [];
		try {
			if ((await this.plan(plan.mode, plan.includeSettings)).id !== plan.id)
				throw new Error(
					"Initialization targets changed; review a fresh final plan",
				);
			await this.external(
				this.store.root,
				this.display(plan, true).targets.map((t) => t.path),
			);
			for (const part of plan.parts)
				await this.helper(part.core, {
					action: "verify",
					consent: offlineConsent,
				});
			await this.mark("executing", undefined, {
				mode: plan.mode,
				includeSettings: plan.includeSettings,
			});
			const consent = {
				confirmation: "INITIALIZE" as const,
				allWritersStopped: true as const,
				automaticRestartersDisabled: true as const,
				exclusiveStorageControl: true as const,
			};
			for (const part of plan.parts) {
				const result = await this.helper(part.core, {
					action: "execute",
					planId: part.plan.id,
					consent,
				}).catch((error) => {
					throw new Error(String(error).replaceAll("/state", part.core));
				});
				completed.push(
					...result.removed.map((file: string) =>
						path.join(part.core, path.relative("/state", file)),
					),
				);
			}
			completed.push(...executeInitialization(plan.root, consent).removed);
			await this.mark("complete");
			this.completed = true;
			return { removed: completed, restartRequired: true };
		} catch (error) {
			const message = `Initialization incomplete. Keep writers stopped. Completed paths: ${completed.join(", ")}. ${String(error)}`;
			await this.mark("failed", message);
			throw new Error(message);
		} finally {
			this.busy = false;
		}
	}
}

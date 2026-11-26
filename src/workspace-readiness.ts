import type {
	PreparedWorkspaceCommand,
	WorkspaceCommandOutcome,
	WorkspaceCommandProfile,
} from "@cybergarage/orbit";
import { spawn } from "node:child_process";
import {
	admitDockerImage,
	assertWorkspaceMountPath,
	command,
	dockerIsolationArgs,
	dockerPath,
	workerUserArgs,
} from "./worker";

export const readinessCommand = String.raw`printf 'workspace command ready\n'`;
const readyOutput = "workspace command ready\n";
const timeoutMs = 12_000;
const ownerLabel = "org.cybergarage.orbit-app.workspace-parent";
const imageLabel = "org.cybergarage.orbit-app.workspace-readiness";
const defaultImage = "docker.io/library/orbit-app-workspace-readiness:local";
const immutable = /^sha256:[a-f0-9]{64}$/;
const unknown: WorkspaceCommandOutcome = { status: "unknown" };

export function readinessInput(input: unknown) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const value = input as Record<string, unknown>;
	return (
		Object.keys(value).every(
			(key) => key === "command" || key === "timeoutSeconds",
		) &&
		value.command === readinessCommand &&
		(value.timeoutSeconds === undefined ||
			value.timeoutSeconds === timeoutMs / 1000)
	);
}

export function readinessProfile(revision: string): WorkspaceCommandProfile {
	if (!immutable.test(revision))
		throw new Error("Invalid readiness image identity");
	return Object.freeze({
		backend: "docker",
		id: "orbit-app-readiness-v1",
		maxResultBytes: 1024,
		network: "none",
		revision,
		timeoutMs,
		workspace: "read-only",
	});
}

function childName(parent: string) {
	const id = /^orbit-app-([a-f0-9-]{36})$/.exec(parent)?.[1];
	if (!id) throw new Error("Invalid readiness owner");
	return `orbit-app-workspace-${id}-probe`;
}

export function readinessArgs(
	parent: string,
	workspace: string,
	artifact: string,
) {
	assertWorkspaceMountPath(workspace);
	readinessProfile(artifact);
	const base = dockerIsolationArgs(
		childName(parent),
		"org.cybergarage.orbit-app.role=workspace-readiness",
	);
	return [
		...base.filter((arg) => arg !== "-i" && arg !== "--rm"),
		"--label",
		`${ownerLabel}=${parent}`,
		"--mount",
		`type=bind,src=${workspace},dst=/workspace,readonly,bind-recursive=disabled`,
		"--workdir",
		"/workspace",
		...workerUserArgs(),
		...[
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"NO_PROXY",
			"ALL_PROXY",
			"FTP_PROXY",
		].flatMap((key) => ["--env", `${key}=`, "--env", `${key.toLowerCase()}=`]),
		"--entrypoint",
		"/usr/local/bin/node",
		artifact,
		"/opt/orbit-readiness.mjs",
	];
}

export async function stopWorkspaceReadiness(parent: string, run = command) {
	const name = childName(parent);
	const find = async () =>
		(
			await run(
				dockerPath,
				[
					"ps",
					"-a",
					"--no-trunc",
					"--filter",
					`name=^/${name}$`,
					"--format",
					"{{.ID}}",
				],
				2000,
			)
		).trim();
	const id = await find();
	if (!id) return;
	if (!/^[0-9a-f]{64}$/.test(id))
		throw new Error("Readiness container identity is invalid");
	const owner = (
		await run(
			dockerPath,
			["inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, id],
			2000,
		)
	).trim();
	if (owner !== parent)
		throw new Error("Readiness container ownership mismatch");
	await run(dockerPath, ["rm", "-f", id], 2000).catch(() => {});
	if (await find()) throw new Error("Readiness child cleanup is unconfirmed");
}

type Invoke = (
	executable: string,
	args: string[],
	signal: AbortSignal,
) => Promise<string>;

const invoke: Invoke = (executable, args, signal) =>
	new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const controller = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
		const child = spawn(executable, args, {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let failed = false;
		const stop = () => {
			failed = true;
			child.kill("SIGKILL");
		};
		controller.addEventListener("abort", stop, { once: true });
		if (controller.aborted) stop();
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 1024) stop();
			else chunks.push(chunk);
		});
		child.once("error", stop);
		child.once("close", (code) => {
			controller.removeEventListener("abort", stop);
			if (failed || controller.aborted || code !== 0)
				reject(new Error("Readiness backend outcome is unknown"));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});

export interface HostCommandProbe {
	admit(): Promise<string>;
	revalidate(artifact: string, signal: AbortSignal): Promise<boolean>;
	execute(
		parent: string,
		workspace: string,
		artifact: string,
		op: PreparedWorkspaceCommand,
		signal: AbortSignal,
		recordExit?: (containerId: string) => Promise<void>,
	): Promise<WorkspaceCommandOutcome>;
	stop(parent: string): Promise<void>;
}

export function approvedReadiness(
	op: PreparedWorkspaceCommand,
	workspace: string,
	artifact: string,
) {
	const profile = readinessProfile(artifact);
	return (
		op.name === "bash" &&
		op.effect === "command" &&
		op.cwd === workspace &&
		op.target === workspace &&
		op.timeoutMs === profile.timeoutMs &&
		op.input.timeoutSeconds === profile.timeoutMs / 1000 &&
		readinessInput(op.input) &&
		Object.entries(profile).every(
			([k, value]) => op.profile[k as keyof WorkspaceCommandProfile] === value,
		)
	);
}

export function createDockerHostCommandProbe(
	image = defaultImage,
	run = command,
	start: Invoke = invoke,
): HostCommandProbe {
	const admit = (selected: string) =>
		admitDockerImage(
			selected,
			imageLabel,
			"standalone readiness probe",
			(exe, args) => run(exe, args, 2000),
		);
	return {
		async admit() {
			try {
				return await admit(image);
			} catch (cause) {
				throw new Error(
					"Readiness probe requires its standalone Docker image. Run npm run worker:readiness:build.",
					{ cause },
				);
			}
		},
		async revalidate(artifact, signal) {
			if (signal.aborted || !immutable.test(artifact)) return false;
			return (await admit(artifact)) === artifact && !signal.aborted;
		},
		async execute(parent, workspace, artifact, op, signal, recordExit) {
			if (signal.aborted || !approvedReadiness(op, workspace, artifact))
				return unknown;
			try {
				const reply = await start(
					dockerPath,
					readinessArgs(parent, workspace, artifact),
					signal,
				);
				if (
					signal.aborted ||
					reply !== JSON.stringify({ exitCode: 0, stdout: readyOutput })
				)
					return unknown;
				if (recordExit) {
					const observed = await run(
						dockerPath,
						[
							"inspect",
							"--format",
							`{{.Id}} {{.Image}} {{.State.Status}} {{.State.ExitCode}} {{index .Config.Labels "${ownerLabel}"}}`,
							childName(parent),
						],
						2000,
					);
					const [id, image, status, code, owner, ...extra] = observed
						.trim()
						.split(/\s+/);
					if (
						signal.aborted ||
						extra.length !== 0 ||
						!/^[0-9a-f]{64}$/.test(id) ||
						image !== artifact ||
						status !== "exited" ||
						code !== "0" ||
						owner !== parent
					)
						return unknown;
					await recordExit(id);
					if (signal.aborted) return unknown;
				}
				return {
					status: "exited",
					exitCode: 0,
					stdout: readyOutput,
					stderr: "",
					text: readyOutput.trim(),
				};
			} catch {
				return unknown;
			} finally {
				await stopWorkspaceReadiness(parent, run);
			}
		},
		stop: (parent) => stopWorkspaceReadiness(parent, run),
	};
}

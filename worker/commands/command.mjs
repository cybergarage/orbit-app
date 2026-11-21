import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/workspace";
const GIT_VIEW = "/opt/orbit-index-view";
const MAX_REQUEST = 4096;
const MAX_SOURCE = 1024 * 1024;
const MAX_OUTPUT = 16 * 1024;
const DEFAULT_MS = 5_000;
const MAX_MS = 15_000;
const DIR =
	fs.constants.O_DIRECTORY | fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const FILE =
	fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const NODE = process.execPath;
const baseEnv = Object.freeze({
	HOME: "/tmp",
	PATH: "/usr/local/bin:/usr/bin:/bin",
	LANG: "C.UTF-8",
	TZ: "UTC",
});
const rejected = (reason) => ({ status: "rejected", reason });
const unknown = (reason) => ({ status: "unknown", reason });
const allowedOperations = new Set([
	"shell-smoke",
	"git-tracked-files",
	"node-check",
	"node-test",
]);

function parse(frame) {
	if (
		!frame ||
		typeof frame !== "object" ||
		Array.isArray(frame) ||
		frame.version !== 1 ||
		!allowedOperations.has(frame.operation)
	)
		throw new Error("Unsupported workspace command");
	const source =
		frame.operation === "node-check" || frame.operation === "node-test";
	const keys = source
		? ["version", "operation", "file", "timeoutMs"]
		: ["version", "operation", "timeoutMs"];
	if (
		Object.keys(frame).some((key) => !keys.includes(key)) ||
		(frame.timeoutMs !== undefined &&
			(!Number.isInteger(frame.timeoutMs) ||
				frame.timeoutMs < 100 ||
				frame.timeoutMs > MAX_MS))
	)
		throw new Error("Invalid workspace command fields");
	if (source) {
		const parts = typeof frame.file === "string" ? frame.file.split("/") : [];
		if (
			!parts.length ||
			parts.length > 16 ||
			frame.file.length > 512 ||
			parts.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) ||
			!/\.(?:mjs|cjs|js)$/.test(frame.file)
		)
			throw new Error("Expected a bounded project-relative JavaScript file");
	}
	return frame;
}

// Linux procfs directory handles bind validation to the selected mount and
// refuse linked directories, terminal symlinks, devices and unbounded inputs.
function openRegular(root, parts) {
	const directories = [];
	try {
		directories.push(fs.openSync(root, DIR));
		for (const part of parts.slice(0, -1))
			directories.push(
				fs.openSync(`/proc/self/fd/${directories.at(-1)}/${part}`, DIR),
			);
		const file = `/proc/self/fd/${directories.at(-1)}/${parts.at(-1)}`;
		const pre = fs.lstatSync(file);
		if (!pre.isFile() || pre.nlink !== 1 || pre.size > MAX_SOURCE)
			throw new Error("Input must be a bounded regular file");
		const fd = fs.openSync(file, FILE);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SOURCE) {
			fs.closeSync(fd);
			throw new Error("Input must be a bounded regular file");
		}
		return fd;
	} finally {
		for (const fd of directories.reverse()) fs.closeSync(fd);
	}
}

function commandPlan(frame, root, gitView) {
	const env = { ...baseEnv };
	if (frame.operation === "shell-smoke")
		return {
			exe: "/bin/bash",
			args: [
				"--noprofile",
				"--norc",
				"-c",
				"printf 'workspace command ready\\n'",
			],
			env,
		};
	if (frame.operation === "git-tracked-files") {
		// Use the image-owned read-only view and consume only the index bytes,
		// never the source repository's config, hooks or linked locations.
		const fd = openRegular(root, [".git", "index"]);
		return {
			exe: "/usr/bin/git",
			args: ["--no-pager", "ls-files", "--cached", "-z"],
			env: {
				...env,
				GIT_DIR: gitView,
				GIT_WORK_TREE: root,
				GIT_INDEX_FILE: "/proc/self/fd/3",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_NO_LAZY_FETCH: "1",
			},
			fd,
			close() {
				fs.closeSync(fd);
			},
		};
	}
	const fd = openRegular(root, frame.file.split("/"));
	fs.closeSync(fd);
	const args =
		frame.operation === "node-check"
			? ["--check"]
			: ["--test", "--test-concurrency=1", "--test-reporter=tap"];
	return { exe: NODE, args: [...args, path.join(root, frame.file)], env };
}

function invoke(plan, root, timeout, signal) {
	if (signal.aborted)
		return Promise.resolve(rejected("Cancelled before start"));
	return new Promise((resolve) => {
		const child = spawn(plan.exe, plan.args, {
			cwd: root,
			env: plan.env,
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe",
				...(plan.fd === undefined ? [] : [plan.fd]),
			],
		});
		let bytes = 0;
		let cause;
		const stdout = [],
			stderr = [];
		const stop = (reason) => {
			cause ??= reason;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const timer = setTimeout(() => stop("Command deadline exceeded"), timeout);
		const abort = () => stop("Command cancelled");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		function capture(chunk, target) {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT) stop("Command output exceeded byte limit");
			else target.push(chunk);
		}
		child.stdout.on("data", (b) => capture(b, stdout));
		child.stderr.on("data", (b) => capture(b, stderr));
		child.once("error", () => {
			cause ??= "Command process unavailable";
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (cause || !Number.isInteger(code))
				resolve(unknown(cause ?? "Command process interrupted"));
			else
				resolve({
					status: "exited",
					exitCode: code,
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
				});
		});
	});
}

export async function command(
	frame,
	{
		root = ROOT,
		gitView = GIT_VIEW,
		signal = new AbortController().signal,
	} = {},
) {
	let plan;
	try {
		frame = parse(frame);
	} catch (error) {
		return rejected(error.message);
	}
	try {
		plan = commandPlan(frame, root, gitView);
	} catch {
		return rejected(
			frame.operation === "git-tracked-files"
				? "Expected a simple standalone Git index in this workspace"
				: "Expected a bounded regular source file in this workspace",
		);
	}
	try {
		return await invoke(plan, root, frame.timeoutMs ?? DEFAULT_MS, signal);
	} finally {
		plan.close?.();
	}
}

async function main() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_REQUEST) {
			process.stdout.write(
				JSON.stringify(rejected("Workspace command frame exceeds byte limit")),
			);
			return;
		}
		chunks.push(chunk);
	}
	let frame;
	try {
		const wire = new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks),
		);
		if (wire.trim().includes("\n"))
			throw new Error("Multiline workspace command");
		frame = JSON.parse(wire);
	} catch {
		process.stdout.write(
			JSON.stringify(rejected("Invalid workspace command frame")),
		);
		return;
	}
	const controller = new AbortController();
	for (const name of ["SIGINT", "SIGTERM"])
		process.once(name, () => controller.abort());
	process.stdout.write(
		JSON.stringify(await command(frame, { signal: controller.signal })),
	);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();

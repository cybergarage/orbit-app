import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, dockerPath, dockerWorkspaceArgs } from "../src/worker";

const tag = `orbit-app-command-fixture:${randomUUID()}`;
const root = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-command-docker-")),
);
const names = new Set<string>();
function invoke(frame: Record<string, unknown>) {
	const name = `orbit-app-workspace-${randomUUID()}-read`;
	names.add(name);
	const args = dockerWorkspaceArgs(name, root, tag, true);
	// Use the same read-only/nonrecursive mount and resource limits as #17.
	const entrypoint = args.indexOf("--entrypoint");
	assert.ok(entrypoint >= 0);
	args[entrypoint + 1] = "/usr/local/bin/node";
	args[args.length - 1] = "/opt/orbit-command.mjs";
	const child = spawnSync(dockerPath, args, {
		input: JSON.stringify({ version: 1, ...frame }),
		encoding: "utf8",
		timeout: 25_000,
		maxBuffer: 128 * 1024, // bounded JSON encoding of the inner 16 KiB cap.
	});
	if (child.error || child.status !== 0)
		throw new Error("Docker command fixture outcome unknown; do not retry");
	return JSON.parse(child.stdout);
}

try {
	await command(
		dockerPath,
		["build", "--tag", tag, "worker/commands"],
		180_000,
	);
	const file = "probe.test.mjs";
	await fs.writeFile(
		path.join(root, file),
		`
		import { test } from "node:test";
		import assert from "node:assert/strict";
		import fs from "node:fs";
		test("workspace is read-only", () => {
			assert.throws(() => fs.writeFileSync("/workspace/probe.txt", "fixture"), { code: "EROFS" });
			assert.equal(process.env.GIT_TERMINAL_PROMPT, undefined);
		});
	`,
	);
	await fs.writeFile(
		path.join(root, "slow.test.mjs"),
		"setTimeout(() => {}, 30000);\n",
	);
	assert.equal(
		invoke({ operation: "shell-smoke" }).stdout,
		"workspace command ready\n",
	);
	assert.equal(invoke({ operation: "node-check", file }).exitCode, 0);
	const test = invoke({ operation: "node-test", file });
	assert.equal(test.exitCode, 0, JSON.stringify(test));
	assert.match(test.stdout, /ok .*workspace is read-only/);
	assert.equal(
		invoke({ operation: "node-test", file: "slow.test.mjs", timeoutMs: 200 })
			.status,
		"unknown",
	);
	assert.equal(
		invoke({ operation: "shell-smoke", env: { PATH: "ignored" } }).status,
		"rejected",
	);
	await assert.rejects(fs.stat(path.join(root, "probe.txt")), {
		code: "ENOENT",
	});

	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
	for (const args of [
		["init", "--quiet", "--template="],
		["add", "--", file],
	]) {
		const git = spawnSync("/usr/bin/git", args, {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(git.status, 0, git.stderr);
	}
	await fs.writeFile(
		path.join(root, ".git", "config"),
		"invalid source config\n",
	);
	assert.deepEqual(invoke({ operation: "git-tracked-files" }), {
		status: "exited",
		exitCode: 0,
		stdout: `${file}\0`,
		stderr: "",
	});
	for (const name of names) {
		const matching = await command(dockerPath, [
			"ps",
			"-a",
			"--filter",
			`name=^/${name}$`,
			"--format",
			"{{.Names}}",
		]);
		assert.equal(matching.trim(), "", "Every fixture container was removed");
	}
	console.log(
		"Verified fixed workspace-only command fixtures: shell, Git index, Node, read-only mount, deadline, and teardown.",
	);
} finally {
	// Exact generated names only, never a Docker-wide cleanup.
	for (const name of names)
		await command(dockerPath, ["rm", "-f", name]).catch(() => {});
	await command(dockerPath, ["image", "rm", tag]).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
}

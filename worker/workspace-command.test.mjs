import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { command } from "./commands/command.mjs";

const linux = process.platform === "linux";
const frame = (operation, extras = {}) => ({
	version: 1,
	operation,
	...extras,
});
async function workspace(t) {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-command-fixture-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

test("declines arbitrary shell/env/config, invalid timeout, flags and unusual path shapes", async () => {
	for (const invalid of [
		{ version: 2, operation: "shell-smoke" },
		frame("bash", { command: "printf ready" }),
		frame("shell-smoke", { command: "printf ready" }),
		frame("shell-smoke", { env: { PATH: "other" } }),
		frame("shell-smoke", { timeoutMs: 16_000 }),
		frame("git-tracked-files", { args: ["--debug"] }),
		...[
			"../main.mjs",
			"dir/../main.mjs",
			"/absolute.mjs",
			"--flag.mjs",
			"file.py",
		].map((file) => frame("node-test", { file })),
	])
		assert.equal((await command(invalid)).status, "rejected");
});

test("fixed shell, bounded JavaScript syntax checks and offline tests report real exit status", {
	skip: !linux,
}, async (t) => {
	const root = await workspace(t);
	const smoke = await command(frame("shell-smoke"), { root });
	assert.deepEqual(smoke, {
		status: "exited",
		exitCode: 0,
		stdout: "workspace command ready\n",
		stderr: "",
	});
	const file = "fixture.test.mjs";
	await fs.writeFile(
		path.join(root, file),
		"import {test} from 'node:test'; test('fixture', ()=>{});",
	);
	assert.equal(
		(await command(frame("node-check", { file }), { root })).exitCode,
		0,
	);
	const result = await command(frame("node-test", { file }), { root });
	assert.equal(result.status, "exited");
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout, /ok .*fixture/);
	await fs.writeFile(path.join(root, file), "const = invalid;");
	const bad = await command(frame("node-check", { file }), { root });
	assert.equal(bad.status, "exited");
	assert.notEqual(bad.exitCode, 0);
	assert.match(bad.stderr, /SyntaxError/);
});

test("reads tracked index entries only, independent of source repository config", {
	skip: !linux,
}, async (t) => {
	const root = await workspace(t);
	const git = (...args) =>
		execFileSync("/usr/bin/git", args, {
			cwd: root,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
	git("init", "--quiet", "--template=");
	await fs.writeFile(path.join(root, "tracked.txt"), "fill");
	await fs.writeFile(path.join(root, "untracked.txt"), "excluded");
	git("add", "--", "tracked.txt");
	await fs.writeFile(
		path.join(root, ".git", "config"),
		"invalid repository configuration\n",
	);
	const observed = await command(frame("git-tracked-files"), { root });
	assert.deepEqual(observed, {
		status: "exited",
		exitCode: 0,
		stdout: "tracked.txt\0",
		stderr: "",
	});
});

test("rejects linked files/metadata, and separates timeout, cancellation and oversized stdout from exit", {
	skip: !linux,
}, async (t) => {
	const root = await workspace(t);
	const file = "fixture.test.mjs";
	await fs.writeFile(path.join(root, file), "setTimeout(() => {}, 30000);");
	await fs.symlink(file, path.join(root, "alias.mjs"));
	await fs.writeFile(path.join(root, ".git"), "gitdir: ../unmounted\n");
	assert.equal(
		(await command(frame("node-test", { file: "alias.mjs" }), { root })).status,
		"rejected",
	);
	assert.equal(
		(await command(frame("git-tracked-files"), { root })).status,
		"rejected",
	);
	assert.match(
		(await command(frame("node-test", { file, timeoutMs: 200 }), { root }))
			.reason,
		/deadline/,
	);
	const abort = new AbortController();
	const active = command(frame("node-test", { file }), {
		root,
		signal: abort.signal,
	});
	abort.abort();
	assert.deepEqual(await active, {
		status: "unknown",
		reason: "Command cancelled",
	});
	assert.equal(
		(
			await command(frame("node-test", { file }), {
				root,
				signal: abort.signal,
			})
		).status,
		"rejected",
	);
	await fs.writeFile(path.join(root, file), "console.log('x'.repeat(32768));");
	assert.deepEqual(await command(frame("node-test", { file }), { root }), {
		status: "unknown",
		reason: "Command output exceeded byte limit",
	});
});

test("one-shot wire rejects multiline and oversized request data", () => {
	const wire = JSON.stringify(frame("shell-smoke"));
	for (const input of [`${wire}\n${wire}`, " ".repeat(4097)]) {
		const r = spawnSync(process.execPath, ["worker/commands/command.mjs"], {
			input,
			timeout: 5000,
			encoding: "utf8",
		});
		assert.equal(r.status, 0);
		assert.equal(JSON.parse(r.stdout).status, "rejected");
	}
});

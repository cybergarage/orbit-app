import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { observe } from "./workspace-reader.mjs";
import { createBuiltinTools } from "@cybergarage/orbit";

const linux = process.platform === "linux";
function request(name, suffix = "", input = {}) {
	const target = `/workspace${suffix}`;
	return {
		version: 1,
		effect: "read",
		name,
		cwd: "/workspace",
		target,
		input: { path: target, ...input },
	};
}
test("read/list/glob/grep preserve exact pinned Core text, details and path rendering", {
	skip: !linux,
}, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-reader-parity-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "folder"));
	for (const [name, contents] of [
		[".gitignore", "excluded.txt\n"],
		["excluded.txt", "needle"],
		["alpha.txt", "first\r\nneedle: alpha\r\nlast\r\n"],
		["folder/beta.txt", "needle: beta\nNeedle once more\n"],
		[".hidden.txt", "Needle hidden\n"],
		["blob.txt", "binary\0needle"],
	])
		await fs.writeFile(path.join(root, name), contents);
	for (const call of [
		request("read", "/alpha.txt", { offset: 2, limit: 2 }),
		request("read", "/blob.txt"),
		request("list", "", { includeHidden: true, limit: 3 }),
		request("list", "/folder"),
		request("glob", "", {
			pattern: ["**/*", "!blob.txt"],
			includeDirectories: true,
			includeHidden: true,
		}),
		request("glob", "/folder", { pattern: "*.txt" }),
		request("grep", "", {
			pattern: "needle",
			ignoreCase: true,
			literal: true,
			contextLines: 1,
		}),
		request("grep", "/alpha.txt", { pattern: "needle:.*", limit: 1 }),
		request("grep", "", { pattern: "no result" }),
	]) {
		const [tool] = createBuiltinTools({ include: [call.name] });
		const core = await tool.execute(
			{
				...call.input,
				path: path.join(root, call.target.slice("/workspace".length)),
			},
			{
				cwd: root,
				callId: "fixture",
				signal: new AbortController().signal,
				emitUpdate() {},
			},
		);
		const translated = JSON.parse(
			JSON.stringify(core).replaceAll(root, "/workspace"),
		);
		assert.deepEqual(
			observe(call, root),
			translated,
			`${call.name} ${call.target}`,
		);
	}
});

test("read limits are independent of mutation replies, with escaped frames and exact Core truncation", {
	skip: !linux,
}, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-reader-limits-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const content = "\t".repeat(180_000) + "日本語".repeat(15_000);
	await fs.writeFile(path.join(root, "long.txt"), content);
	const answer = observe(request("read", "/long.txt"), root);
	const [tool] = createBuiltinTools({ include: ["read"] });
	const core = await tool.execute(
		{ path: path.join(root, "long.txt") },
		{
			cwd: root,
			callId: "fixture",
			signal: new AbortController().signal,
			emitUpdate() {},
		},
	);
	assert.deepEqual(
		answer,
		JSON.parse(JSON.stringify(core).replaceAll(root, "/workspace")),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(answer)) > 16_384);
	await fs.truncate(path.join(root, "long.txt"), 8 * 1024 * 1024 + 1);
	assert.equal(observe(request("read", "/long.txt"), root).isError, true);
});

test("non-workspace operations, symlinks, unsafe filters and multi-frame input fail closed", {
	skip: !linux,
}, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-reader-deny-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "safe"));
	await fs.symlink("safe", path.join(root, "link"));
	await fs.writeFile(path.join(root, "safe", "text"), "inside");
	await fs.symlink("safe/text", path.join(root, "alias"));
	await fs.symlink("safe/text", path.join(root, ".gitignore"));
	for (const operation of [
		request("bash"),
		request("write", "/safe/text"),
		request("read", "/link/text"),
		request("read", "/alias"),
		request("glob", "", { pattern: "*" }),
		request("glob", "", { pattern: "../*" }),
		request("grep", "/safe", { pattern: "inside", glob: "/safe/*" }),
		request("read", "/../safe/text"),
	])
		assert.equal(observe(operation, root).isError, true);
	assert.equal(
		await fs.readFile(path.join(root, "safe", "text"), "utf8"),
		"inside",
	);
	const frame = JSON.stringify(request("read"));
	const runner = spawnSync(process.execPath, ["worker/workspace-reader.mjs"], {
		input: `${frame}\n${frame}`,
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(JSON.parse(runner.stdout).isError, true);
});

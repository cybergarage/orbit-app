import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { executeWorkspaceMutation } from "./workspace/workspace-mutation.mjs";

const linux = { skip: process.platform !== "linux" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const cli = fileURLToPath(
	new URL("./workspace/workspace-mutation.mjs", import.meta.url),
);

function write(content = "new", previous = null, target = "/workspace/note") {
	return {
		version: 1,
		name: "write",
		effect: "write",
		cwd: "/workspace",
		target,
		input: { path: target, content },
		preimageSha256: previous === null ? null : sha(previous),
		resultSha256: sha(content),
	};
}

async function fixture(t) {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-workspace-fixture-"),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return {
		root,
		note: path.join(root, "note"),
		run: (message) => executeWorkspaceMutation(message, root),
	};
}

test(
	"workspace mutation verifies create, exact edit and preimage before overwrite",
	linux,
	async (t) => {
		const { run, note } = await fixture(t);
		assert.equal((await run(write("one $& one"))).isError, undefined);
		const edit = {
			...write("two $& two", "one $& one"),
			name: "edit",
			input: {
				path: "/workspace/note",
				oldText: "one",
				newText: "two",
				replaceAll: true,
			},
		};
		assert.equal((await run(edit)).isError, undefined);
		assert.equal(await fs.readFile(note, "utf8"), "two $& two");
		assert.equal((await run(edit)).isError, true);
		assert.equal((await run(write("unexpected", null))).isError, true);
		assert.equal(await fs.readFile(note, "utf8"), "two $& two");
	},
);

test(
	"rejected paths, result mismatch and invalid input do not mutate the workspace",
	linux,
	async (t) => {
		const { root, run, note } = await fixture(t);
		await fs.writeFile(note, "old");
		for (const op of [
			write("new", "old", "/workspace/../note"),
			write("new", "old", "/workspace-sibling/note"),
			write("new", null, "/workspace/missing/note"),
			{ ...write("new", "old"), resultSha256: sha("incorrect") },
			{ ...write("new", "old"), name: "bash" },
			{ ...write("new", "old"), session: "not admitted" },
		]) {
			assert.equal((await run(op)).isError, true);
			assert.equal(await fs.readFile(note, "utf8"), "old");
		}
		assert.deepEqual(await fs.readdir(root), ["note"]);
	},
);

test(
	"refuses symlink components, hard links and oversized edits",
	linux,
	async (t) => {
		const { root, run, note } = await fixture(t);
		await fs.mkdir(path.join(root, "private"));
		await fs.writeFile(path.join(root, "private", "item"), "old");
		await fs.symlink("private", path.join(root, "symlink"));
		await fs.symlink("private/item", path.join(root, "leaf"));
		await fs.link(path.join(root, "private", "item"), path.join(root, "hard"));
		for (const target of [
			"/workspace/symlink/item",
			"/workspace/leaf",
			"/workspace/hard",
		]) {
			assert.equal((await run(write("new", "old", target))).isError, true);
		}
		assert.equal(
			await fs.readFile(path.join(root, "private", "item"), "utf8"),
			"old",
		);
		const old = "a".repeat(1024);
		await fs.writeFile(note, old);
		const edit = {
			...write("new", old),
			name: "edit",
			input: {
				path: "/workspace/note",
				oldText: "a",
				newText: "x".repeat(2048),
				replaceAll: true,
			},
		};
		assert.equal((await run(edit)).isError, true);
		assert.equal(await fs.readFile(note, "utf8"), old);
	},
);

test("one-shot entry bounds frames and emits no success for cancelled input", async () => {
	for (const input of ["{}\n{}", "x".repeat(1024 * 1024 + 1)]) {
		const result = spawnSync(process.execPath, [cli], {
			input,
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		assert.equal(JSON.parse(result.stdout).isError, true);
	}
	const child = spawn(process.execPath, [cli], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const closed = once(child, "close");
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.kill("SIGTERM");
	const [code, signal] = await closed;
	assert.equal(code, null);
	assert.equal(signal, "SIGTERM");
	assert.equal(output, "");
});

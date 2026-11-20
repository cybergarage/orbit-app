import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeWorkspaceRequest } from "../src/workspace-request";
import { dockerPath, dockerWorkspaceArgs } from "../src/worker";

const image = `docker.io/library/orbit-app-workspace-smoke:${randomUUID()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const root = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-docker-workspace-")),
);
try {
	const build = spawnSync(
		dockerPath,
		["build", "--network=none", "--tag", image, "worker/workspace"],
		{ encoding: "utf8", timeout: 120_000, maxBuffer: 512 * 1024 },
	);
	assert.ifError(build.error);
	assert.equal(build.status, 0, build.stderr);
	const target = path.join(root, "note.txt");
	const invoke = (request: string) => {
		const name = `orbit-app-workspace-${randomUUID()}`;
		try {
			const args = dockerWorkspaceArgs(name, root);
			args[args.length - 1] = image;
			const child = spawnSync(dockerPath, args, {
				input: request,
				encoding: "utf8",
				timeout: 15_000,
				maxBuffer: 16_384,
			});
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stderr);
			return JSON.parse(child.stdout);
		} finally {
			spawnSync(dockerPath, ["rm", "-f", name], {
				timeout: 5_000,
				stdio: "ignore",
			});
		}
	};
	const write = {
		version: 1,
		name: "write",
		effect: "write",
		cwd: root,
		target,
		input: { path: target, content: "generated" },
		preimageSha256: null,
		resultSha256: sha("generated"),
	} as const;
	const create = encodeWorkspaceRequest(root, write);
	assert.equal(invoke(create).isError, undefined);
	assert.equal(await fs.readFile(target, "utf8"), "generated");
	assert.equal(invoke(create).isError, true);
	const edit = encodeWorkspaceRequest(root, {
		...write,
		name: "edit",
		input: { path: target, oldText: "generated", newText: "edited" },
		preimageSha256: sha("generated"),
		resultSha256: sha("edited"),
	});
	assert.equal(invoke(edit).isError, undefined);
	assert.equal(await fs.readFile(target, "utf8"), "edited");
	const wrong = {
		...JSON.parse(edit),
		preimageSha256: sha("edited"),
		resultSha256: sha("wrong"),
		input: {
			path: "/workspace/note.txt",
			oldText: "edited",
			newText: "wrong result",
		},
	};
	assert.equal(invoke(JSON.stringify(wrong)).isError, true);
	await fs.symlink("note.txt", path.join(root, "alias"));
	const alias = path.join(root, "alias");
	assert.equal(
		invoke(
			encodeWorkspaceRequest(root, {
				...write,
				target: alias,
				input: { path: alias, content: "generated" },
				preimageSha256: sha("edited"),
			}),
		).isError,
		true,
	);
	assert.equal(await fs.readFile(target, "utf8"), "edited");
	assert.equal(invoke(`${create}\n${create}`).isError, true);
	const hard = path.join(root, "hard-link");
	await fs.link(target, hard);
	assert.equal(
		invoke(
			encodeWorkspaceRequest(root, {
				...write,
				target: hard,
				input: { path: hard, content: "generated" },
				preimageSha256: sha("edited"),
			}),
		).isError,
		true,
	);
	assert.equal(await fs.readFile(target, "utf8"), "edited");

	console.log(
		"Verified isolated Docker create, edit, stale preimage, wrong digest, links and multi-frame rejection.",
	);
} finally {
	spawnSync(dockerPath, ["image", "rm", image], {
		timeout: 5_000,
		stdio: "ignore",
	});
	await fs.rm(root, { recursive: true, force: true });
}

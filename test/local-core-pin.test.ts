import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

test("unpublished Core source, artifact and CI checkout use the same explicit pin", async () => {
	const root = path.resolve(import.meta.dirname, "..");
	const metadata = JSON.parse(
		await fs.readFile(
			path.join(root, "worker/packages/core-artifact.json"),
			"utf8",
		),
	);
	assert.match(metadata.source.commit, /^[a-f0-9]{40}$/);
	assert.equal(
		metadata.source.repository,
		"https://github.com/cybergarage/orbit.git",
	);
	const workflow = await fs.readFile(
		path.join(root, ".github/workflows/ci.yml"),
		"utf8",
	);
	assert.ok(workflow.includes(`ref: ${metadata.source.commit}`));
	assert.ok(workflow.includes("node scripts/prepare-local-core.mjs ../orbit"));
	const artifact = await fs.readFile(
		path.join(root, "worker/packages", metadata.file),
	);
	assert.equal(
		createHash("sha256").update(artifact).digest("hex"),
		metadata.sha256,
	);
	const host = JSON.parse(
		await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
	);
	const worker = JSON.parse(
		await fs.readFile(path.join(root, "worker/package-lock.json"), "utf8"),
	);
	assert.equal(
		host.packages["node_modules/@cybergarage/orbit"].integrity,
		worker.packages["node_modules/@cybergarage/orbit"].integrity,
	);
	const rejected = spawnSync(
		process.execPath,
		["scripts/prepare-local-core.mjs", "--verify-source", "."],
		{ cwd: root, encoding: "utf8" },
	);
	assert.notEqual(rejected.status, 0);
});

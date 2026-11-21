import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openHostAgentProfile } from "../src/host-profile";
import { NativeProjectCatalog } from "../src/native-catalog";

async function fixture(t: import("node:test").TestContext) {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-catalog-test-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}

test("native catalog refuses legacy marker, uncertain metadata helper, and old roots without probing the addon", async (t) => {
	const root = await fixture(t);
	const older = path.join(root, "legacy-host-agent-v1");
	await fs.mkdir(older, { mode: 0o700 });
	await fs.writeFile(
		path.join(older, ".orbit-app-host-agent-v1"),
		"orbit-app-host-agent-v1\n",
		{ mode: 0o600 },
	);
	const old = new NativeProjectCatalog(older, () =>
		assert.fail("No addon preflight permitted"),
	);
	await assert.rejects(old.prepare(), /unmarked or unsafe profile/);
	await old.close();
	assert.deepEqual(await fs.readdir(older), [".orbit-app-host-agent-v1"]);

	const profile = openHostAgentProfile(path.join(root, "app"));
	const marker = path.join(profile, ".metadata-helper.json");
	await fs.writeFile(marker, "uncertain", { mode: 0o600 });
	const uncertain = new NativeProjectCatalog(profile, () =>
		assert.fail("No addon preflight permitted"),
	);
	await assert.rejects(
		uncertain.prepare(),
		/Metadata recovery record requires review/,
	);
	await uncertain.close();
	await assert.rejects(fs.lstat(path.join(profile, "catalog")), {
		code: "ENOENT",
	});
	assert.equal(await fs.readFile(marker, "utf8"), "uncertain");
});

test("native addon preflight failure never creates a catalog or admits calls", async (t) => {
	const root = await fixture(t);
	const profile = openHostAgentProfile(path.join(root, "app"));
	let attempts = 0;
	const native = new NativeProjectCatalog(profile, () => {
		attempts++;
		throw new Error("synthetic ABI mismatch");
	});
	await assert.rejects(native.prepare(), /ABI mismatch/);
	await assert.rejects(native.prepare(), /ABI mismatch/);
	assert.equal(
		attempts,
		1,
		"Do not retry a failed native owner in the same process",
	);
	await assert.rejects(fs.lstat(path.join(profile, "catalog")), {
		code: "ENOENT",
	});
	await native.close();
	await assert.rejects(
		native.call(path.join(profile, "catalog"), { command: "catalog-query" }),
		/not admitted/,
	);
});

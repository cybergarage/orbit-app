import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { openHostAgentProfile, selectHostAgent } from "../src/host-profile";

async function fixture(t: TestContext) {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-select-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const base = path.join(root, "default");
	return { root, base, host: `${base}-host-agent-native-v2` };
}

test("only native default builds select missing and empty base profiles without writing", async (t) => {
	const { root, base } = await fixture(t);
	assert.equal(selectHostAgent(base, undefined, true), true);
	assert.equal(selectHostAgent(base, undefined, false), false);
	assert.deepEqual(await fs.readdir(root), []);
	await fs.mkdir(base);
	assert.equal(selectHostAgent(base, undefined, true), true);
	assert.deepEqual(await fs.readdir(root), ["default"]);
});

test("a nonempty existing legacy base stays legacy without automatic adoption", async (t) => {
	const { root, base } = await fixture(t);
	await fs.mkdir(base);
	await fs.writeFile(path.join(base, "state.json"), "fixture sentinel");
	assert.equal(selectHostAgent(base, undefined, true), false);
	assert.deepEqual(await fs.readdir(root), ["default"]);
	assert.equal(
		await fs.readFile(path.join(base, "state.json"), "utf8"),
		"fixture sentinel",
	);
});

test("a valid existing Host sibling keeps its identity, with explicit legacy escape", async (t) => {
	const { base, host } = await fixture(t);
	await fs.mkdir(base);
	await fs.writeFile(path.join(base, "state.json"), "legacy sentinel");
	assert.equal(openHostAgentProfile(base), host);
	assert.equal(selectHostAgent(base, undefined, true), true);
	assert.equal(selectHostAgent(base, "0", true), false);
	assert.equal(selectHostAgent(base, "1", false), true);
	assert.equal(selectHostAgent(base, undefined, false), false);
});

test("unsafe existing Host sibling or invalid override refuses silent fallback", async (t) => {
	const { base, host } = await fixture(t);
	await fs.mkdir(host, { mode: 0o700 });
	await fs.writeFile(path.join(host, "state.json"), "unmarked sentinel");
	assert.throws(
		() => selectHostAgent(base, undefined, true),
		/unmarked or unsafe/,
	);
	assert.equal(selectHostAgent(base, "0", true), false);
	assert.throws(() => selectHostAgent(base, "legacy", true), /must be 0 or 1/);
	assert.deepEqual(await fs.readdir(host), ["state.json"]);
});

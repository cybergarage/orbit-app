import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("the App and worker use the same verified exact registry Core pin", async () => {
	const root = path.resolve(import.meta.dirname, "..");
	const { coreName, verifyCoreDependency, verifyCorePin } = await import(
		new URL("../scripts/verify-core-pin.mjs", import.meta.url).href
	);
	const pin = await verifyCorePin(root);
	const manifest = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	const lock = JSON.parse(
		await readFile(path.join(root, "package-lock.json"), "utf8"),
	);
	const coreEntry = `node_modules/${coreName}`;

	for (const version of ["next", `^${pin.version}`, "file:local-core.tgz"]) {
		const bad = structuredClone(manifest);
		bad.dependencies[coreName] = version;
		assert.throws(
			() => verifyCoreDependency(pin, bad, lock, "fixture"),
			/exact Core dependency/,
		);
	}
	const badVersion = structuredClone(lock);
	badVersion.packages[""].dependencies[coreName] = "next";
	assert.throws(
		() => verifyCoreDependency(pin, manifest, badVersion, "fixture"),
		/exact Core lock dependency/,
	);
	const badTarball = structuredClone(lock);
	badTarball.packages[coreEntry].resolved = "https://example.invalid/core.tgz";
	assert.throws(
		() => verifyCoreDependency(pin, manifest, badTarball, "fixture"),
		/Core registry URL/,
	);
	const badIntegrity = structuredClone(lock);
	badIntegrity.packages[coreEntry].integrity = "";
	assert.throws(
		() => verifyCoreDependency(pin, manifest, badIntegrity, "fixture"),
		/Core lock integrity/,
	);
	const badSource = structuredClone(pin);
	badSource.source.commit = "main";
	assert.throws(() =>
		verifyCoreDependency(badSource, manifest, lock, "fixture"),
	);
});

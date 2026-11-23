import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const coreName = "@cybergarage/orbit";
const coreRepository = "https://github.com/cybergarage/orbit";
const coreRegistry = "https://registry.npmjs.org";

export function verifyCoreDependency(pin, manifest, lock, label) {
	assert.match(
		pin.version,
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-next\.(?:0|[1-9]\d*))?$/,
	);
	assert.equal(pin.source.repository, coreRepository);
	assert.equal(pin.source.tag, `v${pin.version}`);
	assert.match(pin.source.commit, /^[0-9a-f]{40}$/);
	assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
	assert.equal(
		pin.resolved,
		`${coreRegistry}/${coreName}/-/orbit-${pin.version}.tgz`,
	);
	assert.equal(
		manifest.dependencies[coreName],
		pin.version,
		`${label}: exact Core dependency`,
	);
	assert.equal(
		lock.packages[""].dependencies[coreName],
		pin.version,
		`${label}: exact Core lock dependency`,
	);
	const locked = lock.packages[`node_modules/${coreName}`];
	assert.equal(locked.version, pin.version, `${label}: Core lock version`);
	assert.equal(locked.resolved, pin.resolved, `${label}: Core registry URL`);
	assert.equal(
		locked.integrity,
		pin.integrity,
		`${label}: Core lock integrity`,
	);
}

export async function verifyCorePin(root) {
	const json = async (...parts) =>
		JSON.parse(await fs.readFile(path.join(root, ...parts), "utf8"));
	const pin = await json("core-pin.json");
	for (const [label, prefix] of [
		["host", []],
		["worker", ["worker"]],
	]) {
		verifyCoreDependency(
			pin,
			await json(...prefix, "package.json"),
			await json(...prefix, "package-lock.json"),
			label,
		);
	}
	return pin;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const pin = await verifyCorePin(path.resolve(import.meta.dirname, ".."));
	console.log(
		`Verified ${coreName}@${pin.version} in both locks (source ${pin.source.commit})`,
	);
}

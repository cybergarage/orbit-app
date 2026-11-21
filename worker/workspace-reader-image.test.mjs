import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const json = (file) =>
	JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
const dockerfile = fs.readFileSync(
	new URL("reader/Dockerfile", import.meta.url),
	"utf8",
);
const context = fs.readFileSync(
	new URL("reader/Dockerfile.dockerignore", import.meta.url),
	"utf8",
);

test("standalone reader resolves only the two pinned runtime dependency trees", () => {
	const manifest = json("reader/package.json");
	const lock = json("reader/package-lock.json").packages;
	const legacy = json("package-lock.json").packages;
	assert.deepEqual(manifest.dependencies, {
		"fast-glob": "3.3.3",
		ignore: "5.3.2",
	});
	assert.deepEqual(lock[""].dependencies, manifest.dependencies);
	const closure = new Set();
	const visit = (name) => {
		const id = `node_modules/${name}`;
		if (closure.has(id)) return;
		closure.add(id);
		const entry = lock[id];
		assert.ok(entry);
		assert.deepEqual(
			entry,
			legacy[id],
			"The same reader source keeps its current version selection",
		);
		assert.match(entry.integrity, /^sha512-/);
		assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
		assert.ok(!entry.link && !entry.dev && !entry.hasInstallScript);
		for (const name of Object.keys(entry.dependencies ?? {})) visit(name);
	};
	for (const name of Object.keys(manifest.dependencies)) visit(name);
	assert.deepEqual(Object.keys(lock).slice(1).sort(), [...closure].sort());
	assert.ok(!closure.has("node_modules/@cybergarage/orbit"));
	assert.ok(!closure.has("node_modules/better-sqlite3"));
});

test("standalone context and final entrypoint do not import legacy Agent material", () => {
	assert.deepEqual(
		context
			.split("\n")
			.filter((line) => line.startsWith("!") && !line.endsWith("/")),
		[
			"!workspace-reader.mjs",
			"!policy.mjs",
			"!reader/package.json",
			"!reader/package-lock.json",
			"!reader/Dockerfile",
			"!reader/Dockerfile.dockerignore",
		],
	);
	assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
	assert.match(dockerfile, /^USER node$/m);
	assert.match(
		dockerfile,
		/^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/worker\/workspace-reader\.mjs"\]$/m,
	);
	assert.doesNotMatch(
		dockerfile,
		/\.tgz|entry\.mjs|names\.mjs|maintenance\.mjs|sources\.mjs/,
	);
});

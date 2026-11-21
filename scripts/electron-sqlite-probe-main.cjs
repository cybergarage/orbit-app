const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

async function verify() {
	const root = process.env.ORBIT_SQLITE_PROBE_ROOT;
	assert.ok(
		root && path.isAbsolute(root),
		"A disposable proof directory is required",
	);
	app.setPath("userData", path.join(root, "profile"));
	app.setPath("sessionData", path.join(root, "profile"));
	app.disableHardwareAcceleration();
	console.log("Entered packaged Electron main");
	await app.whenReady();
	assert.equal(process.versions.electron, "44.5.1");
	assert.equal(process.versions.modules, "149");
	assert.equal(process.platform, "darwin");
	assert.equal(process.arch, "arm64");
	const native = path.join(
		process.resourcesPath,
		"app.asar.unpacked",
		"node_modules",
		"better-sqlite3",
		"build",
		"Release",
		"better_sqlite3.node",
	);
	assert.ok(
		(await fs.stat(native)).isFile(),
		"The ABI-specific native addon must be unpacked",
	);
	console.log("Electron ABI and unpacked native module verified");
	const { SqliteProjectStore } = await import("@cybergarage/orbit");
	const file = path.join(root, "catalog", "projects.sqlite");
	const id = randomUUID();
	let store = await SqliteProjectStore.open({ file });
	try {
		await store.mutate(id, {
			kind: "create",
			id,
			expectedRevision: 0,
			directory: null,
			name: "Synthetic local catalog",
		});
	} finally {
		await store.close();
	}
	store = await SqliteProjectStore.open({ file });
	try {
		const project = await store.query({ kind: "project", id });
		assert.equal(project?.id, id);
		assert.equal(project?.name, "Synthetic local catalog");
	} finally {
		await store.close();
	}
	console.log(
		`Packaged Electron ${process.versions.electron} ABI ${process.versions.modules}: Core SQLite opened, wrote and reopened a disposable catalog.`,
	);
}

verify().then(
	() => app.exit(0),
	(error) => {
		console.error(error);
		app.exit(1);
	},
);

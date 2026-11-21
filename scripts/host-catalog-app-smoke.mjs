import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

async function checksum(dir) {
	const files = (await fs.readdir(dir)).sort();
	const hashes = [];
	for (const name of files) {
		const bytes = await fs.readFile(path.join(dir, name));
		hashes.push([name, createHash("sha256").update(bytes).digest("hex")]);
	}
	return hashes;
}

export async function verifyPackagedCatalog(bundle, executablePath, scratch) {
	const base = path.join(scratch, "legacy");
	const profile = `${base}-host-agent-native-v2`;
	const catalog = path.join(profile, "catalog");
	const addon = path.join(
		bundle,
		"Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
	);
	await fs.mkdir(base, { mode: 0o700 });
	const env = {
		...process.env,
		ORBIT_APP_TEST: "1",
		ORBIT_APP_DATA: base,
		ORBIT_APP_HOST_AGENT: "1",
		ORBIT_APP_NO_HEALTH_TEST: "1",
		ORBIT_APP_LIVE: "0",
		DOCKER_HOST: `unix://${path.join(scratch, "no-docker.sock")}`,
	};
	for (const variable of [
		"ELECTRON_RUN_AS_NODE",
		"NODE_OPTIONS",
		"DOCKER_CONTEXT",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
	])
		delete env[variable];

	const runWithoutInspector = () =>
		spawnSync(executablePath, [], {
			env,
			cwd: scratch,
			timeout: 20_000,
			encoding: "utf8",
			killSignal: "SIGKILL",
		});

	const launch = () =>
		electron.launch({ executablePath, env, timeout: 25_000 });
	let project;
	let first = await launch();
	let processHandle = first.process();
	try {
		const page = await first.firstWindow({ timeout: 15_000 });
		assert.equal(await first.evaluate(() => process.versions.modules), "149");
		project = await page.evaluate(async () =>
			window.orbit.call("create-project", {
				name: "Synthetic packaged catalog project",
			}),
		);
		assert.ok(project.id);
		const duplicate = runWithoutInspector();
		assert.ifError(duplicate.error);
		assert.equal(duplicate.status, 0, duplicate.stderr);
		project = await page.evaluate(
			(input) => window.orbit.call("rename-project", input),
			{
				projectId: project.id,
				name: "Renamed packaged catalog project",
				expectedRevision: project.nameRevision,
				operationId: randomUUID(),
			},
		);
		assert.equal(project.name, "Renamed packaged catalog project");
		await page.evaluate(
			(projectId) =>
				window.orbit.call("knowledge-control", { projectId, enabled: false }),
			project.id,
		);
	} finally {
		await first.close();
	}
	assert.notEqual(
		processHandle.exitCode,
		null,
		"The first packaged App fully quit",
	);

	first = await launch();
	processHandle = first.process();
	try {
		const page = await first.firstWindow({ timeout: 15_000 });
		const state = await page.evaluate(async () =>
			window.orbit.call("snapshot"),
		);
		assert.equal(
			state.projects.find((entry) => entry.id === project.id)?.name,
			project.name,
		);
		const knowledge = await page.evaluate(
			(projectId) => window.orbit.call("knowledge-status", { projectId }),
			project.id,
		);
		assert.equal(knowledge.config.enabled, false);
	} finally {
		await first.close();
	}
	assert.notEqual(
		processHandle.exitCode,
		null,
		"The relaunched packaged App fully quit",
	);
	await assert.rejects(fs.stat(path.join(profile, ".metadata-helper.json")), {
		code: "ENOENT",
	});
	assert.deepEqual(await fs.readdir(base), []);
	const before = await checksum(catalog);
	assert.ok(before.some(([name]) => name === "projects.sqlite"));

	const marker = path.join(profile, ".metadata-helper.json");
	await fs.writeFile(marker, "uncertain", { mode: 0o600, flag: "wx" });
	const blocked = runWithoutInspector();
	assert.ifError(blocked.error);
	assert.equal(blocked.status, 1, blocked.stderr);
	assert.match(blocked.stderr, /Metadata recovery record requires review/);
	assert.equal(await fs.readFile(marker, "utf8"), "uncertain");
	assert.deepEqual(await checksum(catalog), before);
	await fs.unlink(marker);

	// Only this disposable App loses its addon; the installed App and Node tree stay untouched.
	await fs.unlink(addon);
	const refused = runWithoutInspector();
	assert.ifError(refused.error);
	assert.equal(refused.status, 1, refused.stderr);
	assert.match(
		refused.stderr,
		/Native SQLite is unavailable.*Docker fallback is disabled/,
	);
	assert.deepEqual(
		await checksum(catalog),
		before,
		"A failed addon must not change the catalog",
	);
	await assert.rejects(fs.stat(path.join(profile, ".metadata-helper.json")), {
		code: "ENOENT",
	});
	console.log(
		"Packaged Orbit App: synthetic Project persisted across full quit/relaunch with Docker unavailable; missing addon refused without changing catalog bytes.",
	);
}

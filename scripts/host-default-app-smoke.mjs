import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import {
	docker,
	fixtureAppEnv,
	fixtureDockerEnv,
	fixtureProvider,
	releaseImages,
	snapshot,
	stageFixtureImages,
	waitIdle,
} from "./host-file-changes-app-smoke.mjs";

const model = { model: "gpt-4o", provider: "openai" };
const reader = "orbit-app-workspace-reader:local";

export async function verifyPackagedHostDefault(
	bundle,
	executable,
	scratch,
	root,
	{ checkMissingAddon = true } = {},
) {
	const env = await fixtureDockerEnv(scratch);
	const { server, requests, plan, verify } = fixtureProvider();
	const base = path.join(scratch, "fresh-base");
	const legacy = path.join(scratch, "existing-legacy");
	const unavailable = path.join(scratch, "missing-addon");
	const images = [];
	let app;
	try {
		stageFixtureImages(
			env,
			[
				{
					alias: reader,
					kind: "host-default",
					build: [
						"-f",
						path.join(root, "worker/reader/Dockerfile"),
						path.join(root, "worker"),
					],
				},
			],
			images,
		);
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const envFor = (profile, override) => {
			const result = fixtureAppEnv(env, profile, address.port, false);
			if (override === undefined) delete result.ORBIT_APP_HOST_AGENT;
			else result.ORBIT_APP_HOST_AGENT = override;
			// Do not affirm or deny a write opt-in: verify its absent default.
			delete result.ORBIT_APP_HOST_AGENT_FILE_CHANGES;
			delete result.ORBIT_APP_HOST_AGENT_READINESS_PROBE;
			return result;
		};
		const launch = (profile, override) =>
			electron.launch({
				executablePath: executable,
				env: envFor(profile, override),
				timeout: 25_000,
			});
		await Promise.all(
			[base, legacy, unavailable].map((folder) =>
				fs.mkdir(folder, { mode: 0o700 }),
			),
		);
		await fs.writeFile(
			path.join(legacy, "preserve.txt"),
			"existing default profile remains legacy",
		);

		app = await launch(base);
		let page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, "host-readonly");
		const get = (command, payload) =>
			page.evaluate(
				([command, payload]) => window.orbit.call(command, payload),
				[command, payload],
			);
		const project = await get("create-project", {
			name: "Synthetic fresh default",
		});
		await get("knowledge-control", { projectId: project.id, enabled: false });
		const chat = await get("create-session", { projectId: project.id });
		assert.ok(
			chat.workspace.startsWith(`${base}-host-agent-native-v2${path.sep}`),
		);
		await fs.writeFile(
			path.join(chat.workspace, "fixture.txt"),
			"standalone default read marker 4618",
		);
		const submit = () =>
			get("submit", {
				projectId: project.id,
				sessionId: chat.id,
				requestId: randomUUID(),
				prompt: "Read the disposable test file.",
				...model,
			});
		plan(
			["glob", "grep", "list", "read"],
			[["read", { path: "fixture.txt" }], [undefined]],
		);
		await submit();
		await waitIdle(page);
		verify();
		assert.equal(requests.length, 2);
		assert.match(
			JSON.stringify(requests[1].messages),
			/standalone default read marker 4618/,
		);
		assert.equal(
			(await snapshot(page)).projects[0].sessions[0].status,
			"completed",
		);
		assert.equal(
			await fs.readFile(path.join(chat.workspace, "fixture.txt"), "utf8"),
			"standalone default read marker 4618",
		);
		await assert.rejects(fs.stat(path.join(base, "registry")), {
			code: "ENOENT",
		});
		await app.close();
		app = undefined;

		app = await launch(base, "0");
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, undefined);
		assert.deepEqual((await snapshot(page)).projects, []);
		await app.close();
		app = undefined;

		app = await launch(base);
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, "host-readonly");
		assert.equal((await snapshot(page)).projects[0].sessions[0].id, chat.id);
		assert.equal(
			(await snapshot(page)).projects[0].sessions[0].answer,
			"Synthetic package fixture complete.",
		);
		const image = images[0];
		const repoId = docker(
			["image", "inspect", "--format", "{{.Id}}", reader],
			env,
		);
		assert.equal(repoId, image.id, "Remove only the still-owned fixture alias");
		docker(["image", "rm", "--no-prune", reader], env);
		await assert.rejects(submit(), /standalone Docker reader/);
		assert.equal(
			requests.length,
			2,
			"No model call or legacy fallback after reader loss",
		);
		assert.equal((await snapshot(page)).executionBackend, "host-readonly");
		await app.close();
		app = undefined;

		app = await launch(legacy);
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, undefined);
		assert.equal(
			await fs.readFile(path.join(legacy, "preserve.txt"), "utf8"),
			"existing default profile remains legacy",
		);
		await assert.rejects(fs.stat(`${legacy}-host-agent-native-v2`), {
			code: "ENOENT",
		});
		await app.close();
		app = undefined;
		assert.equal(requests.length, 2);

		if (checkMissingAddon) {
			// Only the disposable package loses the addon. Without it a fresh Host
			// startup must report failure, never open the legacy profile.
			const addon = path.join(
				bundle,
				"Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
			);
			await fs.unlink(addon);
			const refused = spawnSync(executable, [], {
				env: envFor(unavailable),
				cwd: scratch,
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 25_000,
			});
			assert.ifError(refused.error);
			assert.equal(refused.status, 1, refused.stderr);
			assert.match(
				refused.stderr,
				/Native SQLite is unavailable.*Docker fallback is disabled/,
			);
			await assert.rejects(fs.stat(path.join(unavailable, "registry")), {
				code: "ENOENT",
			});
			assert.equal(requests.length, 2);
		}

		const failedDependencies = checkMissingAddon
			? "reader/native failures"
			: "reader loss";
		console.log(
			`Packaged Orbit App: new profiles default to Host read-only, legacy opt-out and existing storage remain separate, and ${failedDependencies} do not fall back.`,
		);
	} finally {
		try {
			await app?.close();
		} finally {
			try {
				if (server.listening)
					await new Promise((resolve) => server.close(resolve));
			} finally {
				releaseImages(env, images);
			}
		}
	}
}

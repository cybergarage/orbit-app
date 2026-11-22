import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionRepository } from "@cybergarage/orbit";
import { _electron as electron } from "@playwright/test";
import {
	docker,
	fixtureDockerEnv,
	fixtureAppEnv,
	fixtureProvider,
	releaseImages,
	snapshot,
	stageFixtureImages,
	waitIdle,
} from "./host-file-changes-app-smoke.mjs";

const model = { model: "gpt-4o", provider: "openai" };
const legacyTools = ["bash", "edit", "glob", "grep", "list", "read", "write"];
const firstPrompt =
	"Synthetic legacy conversation asks to keep a local palette.";
const answer = "Synthetic package fixture complete.";
const memoryText =
	"Use cobalt for the fixture palette. Verification marker preserved-memory-4073.";

async function digest(file) {
	return createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");
}

async function directoryDigest(root) {
	const entries = await fs.readdir(root, {
		recursive: true,
		withFileTypes: true,
	});
	const digests = await Promise.all(
		entries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const file = path.join(entry.parentPath, entry.name);
				return [path.relative(root, file), await digest(file)];
			}),
	);
	return new Map(digests);
}

function closedDockerScope(env, base, workspace) {
	const identities = [
		["metadata-profile", base],
		["source-profile", base],
		["workspace", workspace],
	];
	for (const [kind, value] of identities) {
		const found = docker(
			[
				"ps",
				"-a",
				"--filter",
				`label=org.cybergarage.orbit-app.${kind}=${value}`,
				"--format",
				"{{.Names}}",
			],
			env,
		);
		assert.equal(found, "", "Legacy fixture writer/helper still exists");
	}
}

function seedLegacyMemory(env, scratch, id, projectId, artifact) {
	const entry = {
		id,
		projectId,
		title: "Fixture palette",
		body: memoryText,
		retired: false,
		edited: true,
		sources: [],
	};
	const result = JSON.parse(
		docker(
			[
				"run",
				"--rm",
				"--pull=never",
				"-i",
				"--name",
				`orbit-app-profile-test-memory-${randomUUID()}`,
				"--network",
				"none",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--mount",
				`type=bind,src=${path.join(scratch, "legacy/catalog")},dst=/catalog`,
				"--entrypoint",
				"/usr/local/bin/node",
				artifact,
				"/opt/worker/names.mjs",
			],
			env,
			15_000,
			`${JSON.stringify({
				command: "catalog-mutate",
				operationId: randomUUID(),
				mutation: { kind: "memory", expectedRevision: 0, entry },
			})}\n`,
		),
	);
	assert.equal(result.result.id, id);
	assert.equal(result.result.revision, 1);
	return result.result;
}

export async function verifyPackagedProfileTransition(
	executable,
	scratch,
	root,
) {
	const env = await fixtureDockerEnv(scratch);
	const base = path.join(scratch, "legacy");
	const host = `${base}-host-agent-native-v2`;
	const currentRegistry = path.join(base, "registry/state.json");
	const oldRegistry = path.join(base, "state.json");
	const { server, requests, plan, verify } = fixtureProvider();
	const images = [];
	let app;
	try {
		stageFixtureImages(
			env,
			[
				{
					alias: "orbit-app-worker:project-memory-local",
					kind: "legacy-profile",
					build: [path.join(root, "worker")],
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
		const launch = (hostAgent) =>
			electron.launch({
				executablePath: executable,
				env: fixtureAppEnv(env, base, address.port, hostAgent),
				timeout: 25_000,
			});
		await fs.mkdir(base, { mode: 0o700 });

		app = await launch(false);
		let page = await app.firstWindow();
		const call = (command, payload) =>
			page.evaluate(
				([name, input]) => window.orbit.call(name, input),
				[command, payload],
			);
		assert.equal((await snapshot(page)).executionBackend, undefined);
		const origin = await call("create-project", {
			name: "Synthetic legacy origin",
		});
		const target = await call("create-project", {
			name: "Synthetic legacy destination",
		});
		await call("knowledge-control", { projectId: origin.id, enabled: false });
		await call("knowledge-control", { projectId: target.id, enabled: false });
		const chat = await call("create-session", { projectId: origin.id });
		const submit = (projectId, prompt) =>
			call("submit", {
				projectId,
				sessionId: chat.id,
				requestId: randomUUID(),
				prompt,
				...model,
			});
		plan(legacyTools, [[undefined]]);
		await submit(origin.id, firstPrompt);
		await waitIdle(page);
		verify();
		const moved = await call("move-session", {
			projectId: origin.id,
			targetProjectId: target.id,
			sessionId: chat.id,
		});
		assert.equal(moved.id, chat.id);
		assert.equal(moved.storageProjectId, origin.id);
		assert.equal(moved.workspace, chat.workspace);
		assert.equal(moved.answer, answer);
		assert.ok(
			chat.workspace.startsWith(path.join(base, "projects") + path.sep),
		);
		await fs.writeFile(
			path.join(chat.workspace, "synthetic.txt"),
			"legacy workspace unchanged",
		);
		await app.close();
		app = undefined;
		closedDockerScope(env, base, chat.workspace);

		const core = path.join(base, "projects", origin.id, "core");
		const repo = new SessionRepository({
			rootDir: path.join(core, "sessions"),
			journalRoot: path.join(core, "runs"),
		});
		const record = await repo.findById(chat.id);
		assert.equal(record.originator, "orbit-app");
		assert.equal(record.cwd, "/workspace");
		assert.match(
			await fs.readFile(record.file, "utf8"),
			/Synthetic legacy conversation/,
		);
		assert.equal(
			repo.inspectStorage().state,
			"conflicting",
			"A host pathname is not a valid alias for legacy registered roots",
		);
		const memory = seedLegacyMemory(
			env,
			scratch,
			randomUUID(),
			target.id,
			images[0].id,
		);
		// Exercise the supported old registry placement as well, using rename
		// only inside this generated fixture. No companion registry is created.
		await fs.rename(currentRegistry, oldRegistry);
		const registryBefore = await digest(oldRegistry);
		const originalCore = await directoryDigest(core);
		const originalCatalog = await directoryDigest(path.join(base, "catalog"));
		assert.ok(originalCatalog.has("projects.sqlite"));

		app = await launch(true);
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, "host-readonly");
		assert.deepEqual((await snapshot(page)).projects, []);
		await assert.rejects(
			call("knowledge-status", { projectId: target.id }),
			/Project not found|Unknown project/i,
		);
		const hostProject = await call("create-project", {
			name: "Synthetic separate Host project",
		});
		const hostChat = await call("create-session", {
			projectId: hostProject.id,
		});
		assert.notEqual(hostChat.id, chat.id);
		assert.ok(hostChat.workspace.startsWith(host + path.sep));
		assert.equal(await digest(oldRegistry), registryBefore);
		assert.deepEqual(await directoryDigest(core), originalCore);
		assert.deepEqual(
			await directoryDigest(path.join(base, "catalog")),
			originalCatalog,
		);
		await assert.rejects(fs.stat(currentRegistry), { code: "ENOENT" });
		await app.close();
		app = undefined;
		assert.equal(
			requests.length,
			1,
			"The separate Host profile made no model call",
		);
		assert.equal(await digest(oldRegistry), registryBefore);
		assert.deepEqual(await directoryDigest(core), originalCore);
		assert.deepEqual(
			await directoryDigest(path.join(base, "catalog")),
			originalCatalog,
		);
		closedDockerScope(env, base, chat.workspace);

		app = await launch(false);
		page = await app.firstWindow();
		const resumed = await snapshot(page);
		assert.equal(resumed.executionBackend, undefined);
		assert.equal(
			resumed.projects.some((p) => p.id === hostProject.id),
			false,
		);
		assert.deepEqual(
			resumed.projects.find((p) => p.id === origin.id).sessions,
			[],
		);
		const retained = resumed.projects
			.find((p) => p.id === target.id)
			.sessions.find((s) => s.id === chat.id);
		assert.equal(retained.answer, answer);
		assert.equal(retained.storageProjectId, origin.id);
		assert.equal(retained.workspace, chat.workspace);
		assert.equal((await repo.findById(chat.id)).file, record.file);
		assert.equal(
			await fs.readFile(path.join(chat.workspace, "synthetic.txt"), "utf8"),
			"legacy workspace unchanged",
		);
		assert.deepEqual(await directoryDigest(core), originalCore);
		await assert.rejects(fs.stat(oldRegistry), { code: "ENOENT" });
		assert.equal((await fs.stat(currentRegistry)).isFile(), true);
		const knowledge = await call("knowledge-status", { projectId: target.id });
		assert.deepEqual(knowledge.entries, [memory]);
		plan(legacyTools, [[undefined]]);
		await submit(target.id, "Which palette should this fixture use?");
		await waitIdle(page);
		verify();
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[1].messages), /preserved-memory-4073/);
		await app.close();
		app = undefined;
		closedDockerScope(env, base, chat.workspace);
		console.log(
			"Packaged Orbit App: separate Host profile never adopts legacy data; switching back retains the moved chat, workspace, original Core bytes and selected Project memory.",
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

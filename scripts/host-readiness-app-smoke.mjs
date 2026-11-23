import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import {
	checkGone,
	docker,
	fixtureAppEnv,
	fixtureDockerEnv,
	fixtureProvider,
	releaseImages,
	snapshot,
	stageFixtureImages,
	waitIdle,
} from "./host-file-changes-app-smoke.mjs";

const readinessCommand = String.raw`printf 'workspace command ready\n'`;
const model = { provider: "openai", model: "gpt-4o" };

// Query the daemon's event history, not just live containers: the fixed probe
// is short-lived and a premature run could already be gone at approval time.
function probeEvents(env, owner) {
	assert.match(owner, /^orbit-app-[a-f0-9-]{36}$/);
	const events = docker(
		[
			"events",
			"--since",
			"10m",
			"--until",
			"0s",
			"--filter",
			"type=container",
			"--filter",
			"label=org.cybergarage.orbit-app.role=workspace-readiness",
			"--filter",
			`label=org.cybergarage.orbit-app.workspace-parent=${owner}`,
			"--format",
			"{{json .}}",
		],
		env,
	);
	return events ? events.split("\n").map((line) => JSON.parse(line)) : [];
}

function assertNoProbe(env, owner) {
	assert.deepEqual(probeEvents(env, owner), []);
	checkGone(env, owner);
}

function assertOneCompletedProbe(env, owner) {
	const events = probeEvents(env, owner);
	const actions = events.map((event) => event.Action);
	assert.deepEqual(
		actions.filter((action) =>
			["create", "start", "die", "destroy"].includes(action),
		),
		["create", "start", "die", "destroy"],
	);
	assert.equal(new Set(events.map((event) => event.Actor.ID)).size, 1);
	assert.match(events[0].Actor.ID, /^[a-f0-9]{64}$/);
	assert.equal(
		events.find((event) => event.Action === "die").Actor.Attributes.exitCode,
		"0",
	);
	checkGone(env, owner);
}

async function exerciseDecision(page, provider, env, base, imageId, approve) {
	assert.equal((await snapshot(page)).executionBackend, "host-readonly");
	await expect(
		page.getByText(/one approved readiness probe; no general shell/),
	).toBeVisible();
	const ipc = (name, payload) =>
		page.evaluate(
			([name, payload]) => window.orbit.call(name, payload),
			[name, payload],
		);
	const project = await ipc("create-project", {
		name: "Synthetic packaged readiness project",
	});
	await ipc("knowledge-control", { projectId: project.id, enabled: false });
	const chat = await ipc("create-session", { projectId: project.id });
	assert.ok(
		chat.workspace.startsWith(`${base}-host-agent-native-v2${path.sep}`),
	);
	const cwd = await fs.realpath(chat.workspace);
	await page.getByRole("button", { name: "Chat 1", exact: true }).click();
	provider.plan(
		["bash", "glob", "grep", "list", "read"],
		[["bash", { command: readinessCommand }], [undefined]],
	);
	const offset = provider.requests.length;
	assert.deepEqual(
		await ipc("submit", {
			projectId: project.id,
			sessionId: chat.id,
			requestId: randomUUID(),
			prompt: "Ask approval for the fixed synthetic readiness check.",
			...model,
		}),
		{ accepted: true },
	);

	const preview = page.locator(".approval pre");
	await expect(preview).toBeVisible();
	const details = JSON.parse(await preview.innerText());
	assert.deepEqual(details.commandProfile, {
		backend: "docker",
		id: "orbit-app-readiness-v1",
		maxResultBytes: 1024,
		network: "none",
		revision: imageId,
		timeoutMs: 12_000,
		workspace: "read-only",
	});
	assert.equal(details.name, "bash");
	assert.equal(details.cwd, cwd);
	assert.equal(details.command, readinessCommand);
	assert.equal(details.timeoutSeconds, 12);
	assert.match(details.execution, /fixed Docker readiness probe/i);
	const { active } = await snapshot(page);
	assert.equal(active.workspaceReadiness, true);
	assert.equal(active.workspaceMutations, undefined);
	assert.equal(active.containerName, undefined);
	assert.equal(provider.requests.length, offset + 1);
	assertNoProbe(env, active.readerOwner);

	await page
		.getByRole("button", { name: approve ? "Approve" : "Deny", exact: true })
		.click();
	await waitIdle(page);
	await expect(preview).toBeHidden();
	provider.verify();
	assert.equal(provider.requests.length, offset + 2);
	const result = provider.requests
		.at(-1)
		.messages.findLast((m) => m.role === "tool");
	assert.ok(result, "The real tool result must reach the synthetic model");
	if (approve) {
		assert.match(result.content, /workspace command ready/);
		assertOneCompletedProbe(env, active.readerOwner);
	} else {
		assert.match(result.content, /Operation denied/);
		assertNoProbe(env, active.readerOwner);
	}
	const session = (await snapshot(page)).projects
		.find(({ id }) => id === project.id)
		.sessions.find(({ id }) => id === chat.id);
	assert.equal(session.status, "completed");
	assert.equal(session.answer, "Synthetic package fixture complete.");
	assert.deepEqual(await fs.readdir(cwd), []);
}

async function exerciseProfile(executablePath, base, port, env, host, test) {
	await fs.mkdir(base, { mode: 0o700 });
	const app = await electron.launch({
		executablePath,
		env: {
			...fixtureAppEnv(env, base, port, host),
			ORBIT_APP_HOST_AGENT_READINESS_PROBE: "1",
		},
		timeout: 25_000,
	});
	try {
		await test(await app.firstWindow());
	} finally {
		await app.close();
	}
}

export async function verifyPackagedWorkspaceReadiness(
	executablePath,
	scratch,
	root,
) {
	const env = await fixtureDockerEnv(scratch);
	const provider = fixtureProvider();
	const { server } = provider;
	const images = [];
	try {
		stageFixtureImages(
			env,
			[
				{
					alias: "orbit-app-workspace-reader:local",
					kind: "readiness-reader",
					build: [
						"-f",
						path.join(root, "worker/reader/Dockerfile"),
						path.join(root, "worker"),
					],
				},
				{
					alias: "orbit-app-workspace-readiness:local",
					kind: "readiness-probe",
					build: ["--network=none", path.join(root, "worker/readiness")],
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
		await exerciseProfile(
			executablePath,
			path.join(scratch, "legacy"),
			address.port,
			env,
			false,
			async (page) => {
				const state = await snapshot(page);
				assert.equal(state.executionBackend, undefined);
				assert.equal(state.executionReadinessProbe, undefined);
				assert.equal(provider.requests.length, 0);
			},
		);
		for (const approve of [false, true]) {
			const base = path.join(scratch, approve ? "approved" : "denied");
			await exerciseProfile(
				executablePath,
				base,
				address.port,
				env,
				true,
				(page) =>
					exerciseDecision(page, provider, env, base, images[1].id, approve),
			);
		}
		console.log(
			"Packaged Orbit App: fixed readiness preview, denial without launch, approved Docker execution and cleanup, and legacy opt-out verified.",
		);
	} finally {
		try {
			if (server.listening)
				await new Promise((resolve) => server.close(resolve));
		} finally {
			releaseImages(env, images);
		}
	}
}

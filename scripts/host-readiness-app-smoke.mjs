import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
const readinessAlias = "orbit-app-workspace-readiness:local";
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

function call(page, name, payload) {
	return page.evaluate(
		([name, payload]) => window.orbit.call(name, payload),
		[name, payload],
	);
}

async function openChat(page, base) {
	assert.equal((await snapshot(page)).executionBackend, "host-readonly");
	await expect(
		page.getByText(/one approved readiness probe; no general shell/),
	).toBeVisible();
	const ipc = (name, payload) => call(page, name, payload);
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
	return {
		cwd,
		selectModel: () =>
			ipc("select-model", {
				projectId: project.id,
				sessionId: chat.id,
				...model,
			}),
		submit: (currentPage = page) =>
			call(currentPage, "submit", {
				projectId: project.id,
				sessionId: chat.id,
				requestId: randomUUID(),
				prompt: "Ask approval for the fixed synthetic readiness check.",
				...model,
			}),
		session: async (currentPage = page) =>
			(await snapshot(currentPage)).projects
				.find(({ id }) => id === project.id)
				.sessions.find(({ id }) => id === chat.id),
	};
}

async function prepareDecision(page, provider, env, base, imageId, followUp) {
	const chat = await openChat(page, base);
	const calls = [["bash", { command: readinessCommand }]];
	if (followUp) calls.push([undefined]);
	provider.plan(["bash", "glob", "grep", "list", "read"], calls);
	const offset = provider.requests.length;
	assert.deepEqual(await chat.submit(), { accepted: true });

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
	assert.equal(details.cwd, chat.cwd);
	assert.equal(details.command, readinessCommand);
	assert.equal(details.timeoutSeconds, 12);
	assert.match(details.execution, /fixed Docker readiness probe/i);
	const { active } = await snapshot(page);
	assert.equal(active.workspaceReadiness, true);
	assert.equal(active.workspaceMutations, undefined);
	assert.equal(active.containerName, undefined);
	assert.equal(provider.requests.length, offset + 1);
	assertNoProbe(env, active.readerOwner);

	return { chat, preview, owner: active.readerOwner, offset };
}

async function exerciseDecision(page, provider, env, base, imageId, approve) {
	const { chat, preview, owner, offset } = await prepareDecision(
		page,
		provider,
		env,
		base,
		imageId,
		true,
	);

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
		assertOneCompletedProbe(env, owner);
	} else {
		assert.match(result.content, /Operation denied/);
		assertNoProbe(env, owner);
	}
	const session = await chat.session();
	assert.equal(session.status, "completed");
	assert.equal(session.answer, "Synthetic package fixture complete.");
	assert.deepEqual(await fs.readdir(chat.cwd), []);
}

function launch(executablePath, base, port, env, host, readiness = true) {
	return electron.launch({
		executablePath,
		env: {
			...fixtureAppEnv(env, base, port, host),
			ORBIT_APP_HOST_AGENT_READINESS_PROBE: readiness ? "1" : "0",
		},
		timeout: 25_000,
	});
}

async function exerciseProfile(executablePath, base, port, env, host, test) {
	await fs.mkdir(base, { mode: 0o700 });
	const app = await launch(executablePath, base, port, env, host);
	try {
		await test(await app.firstWindow());
	} finally {
		await app.close();
	}
}

async function exerciseRefusal(page, provider, base) {
	const chat = await openChat(page, base);
	const count = provider.requests.length;
	provider.plan([], []);
	await chat.selectModel();
	await page
		.getByRole("textbox", { name: "Task", exact: true })
		.fill("Refuse the missing synthetic readiness probe.");
	await page.getByRole("button", { name: /^Run task/ }).click();
	await expect(page.getByRole("alert")).toContainText(
		"including the readiness probe",
	);
	const state = await snapshot(page);
	assert.equal(state.executionBackend, "host-readonly");
	assert.equal(state.executionReadinessProbe, true);
	assert.equal(state.active, undefined);
	assert.equal(provider.requests.length, count);
	provider.verify();
	await expect(page.locator(".approval")).toBeHidden();
	await assert.rejects(fs.stat(path.join(base, "registry")), {
		code: "ENOENT",
	});
}

async function waitProbeRunning(env, owner) {
	const name = `orbit-app-workspace-${owner.slice("orbit-app-".length)}-probe`;
	const check = () =>
		docker(
			[
				"ps",
				"--no-trunc",
				"--filter",
				`name=^/${name}$`,
				"--filter",
				`label=org.cybergarage.orbit-app.workspace-parent=${owner}`,
				"--filter",
				"label=org.cybergarage.orbit-app.role=workspace-readiness",
				"--format",
				"{{.ID}}",
			],
			env,
		);
	await expect
		.poll(check, { timeout: 4_000, intervals: [50, 75, 100] })
		.toMatch(/^[a-f0-9]{64}$/);
	const child = check();
	assert.match(child, /^[a-f0-9]{64}$/);
	return child;
}

async function assertProbeTerminated(env, owner, child) {
	const lifecycle = ["create", "start", "die", "destroy"];
	// Container teardown and event delivery run separately in the daemon.
	let events = [];
	await expect
		.poll(
			() => {
				events = probeEvents(env, owner);
				return events
					.map(({ Action }) => Action)
					.filter((action) => lifecycle.includes(action));
			},
			{ timeout: 5_000 },
		)
		.toEqual(lifecycle);
	assert.deepEqual(
		new Set(events.map(({ Actor }) => Actor.ID)),
		new Set([child]),
	);
	assert.match(
		events.find(({ Action }) => Action === "die").Actor.Attributes.exitCode,
		/^[1-9]\d*$/,
	);
	checkGone(env, owner);
}

function assertNoReplay(provider, offset) {
	assert.equal(provider.requests.length, offset + 1);
	provider.verify();
}

async function exerciseCancellation(
	page,
	provider,
	env,
	base,
	imageId,
	running,
) {
	const { chat, preview, owner, offset } = await prepareDecision(
		page,
		provider,
		env,
		base,
		imageId,
		false,
	);
	let child;
	if (running) {
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		child = await waitProbeRunning(env, owner);
	}
	await page.getByRole("button", { name: "Stop worker", exact: true }).click();
	if (child) {
		await expect
			.poll(async () => (await snapshot(page)).recoveryBlocked, {
				timeout: 8_000,
			})
			.toBe(true);
		await assertProbeTerminated(env, owner, child);
		await assertRetainedRecovery(page, chat, owner);
		const terminal = (await chat.session()).events.findLast(
			({ type }) => type === "result",
		)?.data.runtime;
		assert.equal(terminal.outcome, "incomplete");
		assert.equal(terminal.quiescence, false);
		assert.deepEqual(
			terminal.operations.map(({ status }) => status),
			["unknown"],
		);
	} else {
		await waitIdle(page);
		const session = await chat.session();
		assert.equal(session.status, "cancelled");
		assert.ok(!session.answer);
		assertNoProbe(env, owner);
	}
	await expect(preview).toBeHidden();
	await expect(page.getByText(/Stop requested/)).toBeVisible();
	assertNoReplay(provider, offset);
}

// Disposal and Core safety are separate: tearing down Docker does not
// resolve a dispatched command's unknown outcome or release its writer.
async function assertRetainedRecovery(page, chat, owner) {
	const state = await snapshot(page);
	assert.equal(state.recoveryBlocked, true);
	assert.equal(state.active.readerOwner, owner);
	assert.equal(state.active.workspaceReadiness, true);
	const session = await chat.session(page);
	assert.equal(session.status, "recovery-blocked");
	assert.ok(!session.answer);
	await assert.rejects(chat.submit(page), /already active|recovery is blocked/);
}

async function exerciseRestart(
	executablePath,
	base,
	port,
	env,
	provider,
	imageId,
) {
	await fs.mkdir(base, { mode: 0o700 });
	let app = await launch(executablePath, base, port, env, true);
	try {
		const page = await app.firstWindow();
		const { chat, owner, offset } = await prepareDecision(
			page,
			provider,
			env,
			base,
			imageId,
			false,
		);
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		const child = await waitProbeRunning(env, owner);
		const process = app.process();
		const exited = once(process, "exit", {
			signal: AbortSignal.timeout(5_000),
		});
		assert.ok(
			process.kill("SIGKILL"),
			"Stop only this synthetic Electron instance",
		);
		const [, signal] = await exited;
		assert.equal(signal, "SIGKILL");
		app = undefined;
		assert.equal(await waitProbeRunning(env, owner), child);

		app = await launch(executablePath, base, port, env, true, false);
		const reopened = await app.firstWindow();
		const state = await snapshot(reopened);
		assert.equal(state.executionBackend, "host-readonly");
		assert.equal(state.executionReadinessProbe, undefined);
		await assertProbeTerminated(env, owner, child);
		await assertRetainedRecovery(reopened, chat, owner);
		assertNoReplay(provider, offset);
	} finally {
		await app?.close();
	}
}

async function delayedImage(env, scratch, root, images) {
	const context = path.join(scratch, "delayed-probe");
	await fs.mkdir(context, { mode: 0o700 });
	const dockerfile = await fs.readFile(
		path.join(root, "worker/readiness/Dockerfile"),
		"utf8",
	);
	await fs.writeFile(path.join(context, "Dockerfile"), dockerfile);
	// No synthetic success response; the test must observe a live process first.
	await fs.writeFile(
		path.join(context, "probe.mjs"),
		"setTimeout(() => {}, 20000);\n",
	);
	stageFixtureImages(
		env,
		[
			{
				alias: readinessAlias,
				kind: "readiness-interruptible",
				build: ["--network=none", context],
			},
		],
		images,
	);
	return images.at(-1).id;
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
					alias: readinessAlias,
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
		const inProfile = (name, test) =>
			exerciseProfile(
				executablePath,
				path.join(scratch, name),
				address.port,
				env,
				true,
				test,
			);
		const productionId = images.at(-1).id;
		const decision = (name, approve) =>
			inProfile(name, (page) =>
				exerciseDecision(
					page,
					provider,
					env,
					path.join(scratch, name),
					productionId,
					approve,
				),
			);
		await decision("denied", false);
		await decision("approved", true);
		await inProfile("stop-pending", (page) =>
			exerciseCancellation(
				page,
				provider,
				env,
				path.join(scratch, "stop-pending"),
				productionId,
				false,
			),
		);
		releaseImages(env, [images.at(-1)]);
		images.pop();
		await inProfile("missing-probe", (page) =>
			exerciseRefusal(page, provider, path.join(scratch, "missing-probe")),
		);
		const delayedId = await delayedImage(env, scratch, root, images);
		await inProfile("stop-running", (page) =>
			exerciseCancellation(
				page,
				provider,
				env,
				path.join(scratch, "stop-running"),
				delayedId,
				true,
			),
		);
		await exerciseRestart(
			executablePath,
			path.join(scratch, "restart"),
			address.port,
			env,
			provider,
			delayedId,
		);

		console.log(
			"Packaged Orbit App: fixed readiness preview, denial without launch, approved execution, cancellation, restart recovery, missing image refusal, and legacy opt-out verified.",
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

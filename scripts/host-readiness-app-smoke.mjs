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

async function settledProbeEvents(env, owner) {
	const lifecycle = ["create", "start", "die", "destroy"];
	// Teardown and event delivery run separately in the Docker daemon.
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
	return events;
}

async function assertOneCompletedProbe(env, owner) {
	const events = await settledProbeEvents(env, owner);
	assert.equal(new Set(events.map(({ Actor }) => Actor.ID)).size, 1);
	assert.match(events[0].Actor.ID, /^[a-f0-9]{64}$/);
	assert.equal(
		events.find(({ Action }) => Action === "die").Actor.Attributes.exitCode,
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

	let observed = false;
	provider.beforeReply(async () => {
		const state = await readRegistry(base);
		const { active } = state;
		if (!approve) {
			assert.equal(active.hostReadinessReceipt, undefined);
		} else {
			const receipt = active.hostReadinessReceipt;
			assert.equal(receipt.outcome, "fixed-probe-exited-zero");
			assert.equal(receipt.executorOwner, owner);
			assert.equal(receipt.image, imageId);
			assert.equal(receipt.storagePairId, active.hostRecovery.storagePairId);
			assert.equal(receipt.orbitRunId, active.hostRecovery.orbitRunId);
			assert.equal(receipt.sessionId, active.sessionId);
			assert.deepEqual(active.hostApprovalAttempts, [receipt.approval]);
			assert.match(receipt.containerId, /^[a-f0-9]{64}$/);
		}
		assert.equal((await snapshot(page)).active.hostReadinessReceipt, undefined);
		observed = true;
	});

	await page
		.getByRole("button", { name: approve ? "Approve" : "Deny", exact: true })
		.click();
	await waitIdle(page);
	await expect(preview).toBeHidden();
	provider.beforeReply(undefined);
	provider.verify();
	assert.ok(observed, "Synthetic follow-up checked the persisted registry");
	assert.equal(provider.requests.length, offset + 2);
	const result = provider.requests
		.at(-1)
		.messages.findLast((m) => m.role === "tool");
	assert.ok(result, "The real tool result must reach the synthetic model");
	if (approve) {
		assert.match(result.content, /workspace command ready/);
		await assertOneCompletedProbe(env, owner);
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
			...(process.env.ORBIT_APP_TEST_DISPLAY
				? { ORBIT_APP_TEST_DISPLAY: process.env.ORBIT_APP_TEST_DISPLAY }
				: {}),
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
	const events = await settledProbeEvents(env, owner);
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
		assert.equal((await snapshot(page)).recoveryBlockReason, undefined);
		await expect(page.locator(".recovery-notice")).toBeHidden();
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
	assert.equal(state.recoveryBlockReason, "host-writer-retained");
	assert.equal(state.active.readerOwner, owner);
	assert.equal(state.active.workspaceReadiness, true);
	const session = await chat.session(page);
	assert.equal(session.status, "recovery-blocked");
	assert.ok(!session.answer);
	await assert.rejects(chat.submit(page), /already active|recovery is blocked/);
	await page.getByRole("button", { name: session.name, exact: true }).click();
	const notice = page.locator(".recovery-notice");
	await expect(notice).toContainText("The Docker worker has stopped");
	await expect(notice).toContainText("new runs are blocked");
	await expect(notice).toContainText("Your chat is saved");
	await expect(
		page.getByText("Ask approval for the fixed synthetic readiness check.", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Stop worker", exact: true }),
	).toBeHidden();
	await expect(
		page.getByRole("button", { name: /^(Run|Retry) task/ }),
	).toBeHidden();

	await page.getByRole("button", { name: /Runtime ·/ }).click();
	await expect(notice).toContainText(
		"Reconnecting Docker alone will not clear",
	);
	await page.getByRole("button", { name: "Back to Home", exact: true }).click();
	await page.getByRole("button", { name: session.name, exact: true }).click();
}

async function confirmTestDisplay(app, phase) {
	const label = process.env.ORBIT_APP_TEST_DISPLAY;
	if (!label) return;
	const readPlacement = () =>
		app.evaluate(({ BrowserWindow, screen }, label) => {
			const targets = screen
				.getAllDisplays()
				.filter((display) => display.label === label);
			if (targets.length !== 1)
				throw new Error(`Expected one active display named ${label}`);
			const [display] = targets;
			const windows = BrowserWindow.getAllWindows().filter((window) =>
				window.isVisible(),
			);
			// firstWindow can resolve while loadFile is still completing and the
			// display-guarded window has not been shown.
			if (windows.length === 0) return null;
			if (windows.length !== 1)
				throw new Error("Expected one visible fixture window");
			const [window] = windows;
			const bounds = window.getBounds();

			return {
				expected: display.id,
				actual: screen.getDisplayMatching(bounds).id,
			};
		}, label);
	await expect
		.poll(
			async () => {
				const result = await readPlacement();
				if (!result) return false;
				assert.equal(
					result.actual,
					result.expected,
					`Fixture window placement: ${phase}`,
				);
				return true;
			},
			{ timeout: 5_000, message: `Fixture window visible: ${phase}` },
		)
		.toBe(true);
	console.log(`Packaged Orbit App: verified display ${label} (${phase}).`);
}

function registryPath(base) {
	return path.join(`${base}-host-agent-native-v2`, "registry", "state.json");
}

async function readRegistry(base) {
	return JSON.parse(await fs.readFile(registryPath(base), "utf8"));
}

function runEvidencePaths(cwd, active) {
	const core = path.join(path.dirname(cwd), "core");
	return {
		journal: path.join(
			core,
			"runs",
			active.sessionId,
			active.hostRecovery.orbitRunId,
			"events.jsonl",
		),
		writer: path.join(
			core,
			"sessions",
			".coordination",
			`${active.sessionId}.owner`,
		),
	};
}

function operationEvents(bytes, operationId) {
	return bytes
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter(({ data }) => data.operationId === operationId);
}

// Only the synthetic Electron process is instrumented. At the exact owned
// child's removal, the receipt is on disk but the command has not returned to
// Core. This does not replace stdout, Docker exit evidence, or Core events.
async function armReceiptCrash(app, base, owner, marker) {
	await app.evaluate(
		(_, { registry, owner, marker }) => {
			const fs = process.getBuiltinModule("node:fs");
			const children = process.getBuiltinModule("node:child_process");
			const { spawn } = children;
			children.spawn = function (file, args, ...options) {
				if (
					file === "/usr/local/bin/docker" &&
					args?.length === 3 &&
					args[0] === "rm" &&
					args[1] === "-f"
				) {
					const { active } = JSON.parse(fs.readFileSync(registry, "utf8"));
					const receipt = active?.hostReadinessReceipt;
					if (
						receipt?.executorOwner === owner &&
						receipt.containerId === args[2]
					) {
						fs.writeFileSync(marker, receipt.containerId, {
							flag: "wx",
							mode: 0o600,
						});
						process.kill(process.pid, "SIGSTOP");
						throw Error("The synthetic crash fixture must not resume");
					}
				}
				return spawn.call(this, file, args, ...options);
			};
		},
		{ registry: registryPath(base), owner, marker },
	);
}

async function exerciseRestartBeforeResult(
	executablePath,
	base,
	port,
	env,
	provider,
	imageId,
	conflicting,
) {
	await fs.mkdir(base, { mode: 0o700 });
	let app = await launch(executablePath, base, port, env, true);
	let owner;
	let armed = false;
	try {
		const page = await app.firstWindow();
		await confirmTestDisplay(app, "before pending-result interruption");
		const prepared = await prepareDecision(
			page,
			provider,
			env,
			base,
			imageId,
			false,
		);
		const { chat, offset } = prepared;
		owner = prepared.owner;
		const marker = path.join(base, "receipt-crash-barrier");
		await armReceiptCrash(app, base, owner, marker);
		armed = true;
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await expect
			.poll(
				async () => (await fs.stat(marker).catch(() => undefined))?.isFile(),
				{
					timeout: 15_000,
				},
			)
			.toBe(true);
		const interrupted = app;
		app = undefined;
		await killFixtureApp(interrupted);
		armed = false;

		const registry = await readRegistry(base);
		const { active } = registry;
		const receipt = active.hostReadinessReceipt;
		assert.equal(receipt.executorOwner, owner);
		assert.equal(receipt.image, imageId);
		const child = await fs.readFile(marker, "utf8");
		assert.match(child, /^[a-f0-9]{64}$/);
		assert.equal(receipt.containerId, child);
		assert.equal(
			docker(
				["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", child],
				env,
			),
			"exited 0",
		);
		const { journal, writer } = runEvidencePaths(chat.cwd, active);
		const [journalBefore, writerBefore, writerStat] = await Promise.all([
			fs.readFile(journal),
			fs.readFile(writer),
			fs.stat(writer),
		]);
		const operation = operationEvents(
			journalBefore,
			receipt.approval.operationId,
		);
		assert.ok(operation.some(({ kind }) => kind === "operation-intent"));
		assert.ok(!operation.some(({ kind }) => kind === "operation-result"));
		if (conflicting) {
			// Change only this synthetic registry, after its writer has died.
			receipt.image = `sha256:${"0".repeat(64)}`;
			assert.notEqual(receipt.image, imageId);
			await fs.writeFile(registryPath(base), JSON.stringify(registry));
		}
		app = await launch(executablePath, base, port, env, true, false);
		const reopened = await app.firstWindow();
		await confirmTestDisplay(app, "after pending-result relaunch");
		await assertRetainedRecovery(reopened, chat, owner);
		await assertOneCompletedProbe(env, owner);
		const notice = reopened.locator(".recovery-notice");
		await expect(notice).toContainText(
			conflicting
				? "The saved readiness probe report could not be verified."
				: "The saved readiness probe report matches the original approval.",
		);
		assert.equal(
			(await snapshot(reopened)).active.hostReadinessReceipt,
			undefined,
		);
		assert.deepEqual((await snapshot(reopened)).hostRestartDiagnostic, {
			journal: "open",
			unresolvedOperations: 1,
			readinessReceipt: conflicting ? "unverified" : "approval-matched",
		});
		assert.deepEqual(
			(await readRegistry(base)).active.hostReadinessReceipt,
			receipt,
		);
		assert.deepEqual(await fs.readFile(journal), journalBefore);
		assert.deepEqual(await fs.readFile(writer), writerBefore);
		assert.equal((await fs.stat(writer)).ino, writerStat.ino);
		assertNoReplay(provider, offset);
	} finally {
		if (app && armed) {
			await killFixtureApp(app);
		} else {
			await app?.close();
		}
		if (owner) {
			// Remove only a remaining fixture child with our exact owner and role.
			const child = docker(
				[
					"ps",
					"-aq",
					"--no-trunc",
					"--filter",
					`label=org.cybergarage.orbit-app.workspace-parent=${owner}`,
					"--filter",
					"label=org.cybergarage.orbit-app.role=workspace-readiness",
				],
				env,
			);
			if (child) {
				assert.match(child, /^[a-f0-9]{64}$/);
				docker(["rm", "-f", child], env);
			}
		}
	}
}

async function killFixtureApp(app) {
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
}

async function exerciseRestartAfterReceipt(
	executablePath,
	base,
	port,
	env,
	provider,
	imageId,
) {
	await fs.mkdir(base, { mode: 0o700 });
	let app = await launch(executablePath, base, port, env, true);
	let finishReply;
	const pending = new Promise((resolve) => {
		finishReply = resolve;
	});
	try {
		const page = await app.firstWindow();
		await confirmTestDisplay(app, "before interruption after receipt");
		const { chat, owner, offset } = await prepareDecision(
			page,
			provider,
			env,
			base,
			imageId,
			true,
		);
		let record;
		provider.beforeReply(async () => {
			record = (await readRegistry(base)).active.hostReadinessReceipt;
			if (record) await pending;
		});
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await expect.poll(() => record?.outcome).toBe("fixed-probe-exited-zero");
		assert.equal(record.executorOwner, owner);
		await assertOneCompletedProbe(env, owner);
		assert.equal(provider.requests.length, offset + 2);
		const { active } = await readRegistry(base);
		const { journal, writer } = runEvidencePaths(chat.cwd, active);
		const [journalBefore, writerBefore] = await Promise.all([
			fs.readFile(journal),
			fs.readFile(writer),
		]);
		assert.ok(
			operationEvents(journalBefore, record.approval.operationId).some(
				({ kind, data }) =>
					kind === "operation-result" && data.status === "succeeded",
			),
		);
		await killFixtureApp(app);
		app = undefined;
		provider.beforeReply(undefined);
		finishReply();
		assert.deepEqual(
			(await readRegistry(base)).active.hostReadinessReceipt,
			record,
		);
		app = await launch(executablePath, base, port, env, true, false);
		const reopened = await app.firstWindow();
		await confirmTestDisplay(app, "after relaunch with receipt");
		await assertRetainedRecovery(reopened, chat, owner);
		assert.deepEqual(
			(await readRegistry(base)).active.hostReadinessReceipt,
			record,
		);
		const resumed = await snapshot(reopened);
		assert.equal(resumed.active.hostReadinessReceipt, undefined);
		// The provider already received the result and Core's exact operation
		// binding must be verified independently of the observation in the fixture.
		assert.deepEqual(resumed.hostRestartDiagnostic, {
			journal: "open",
			unresolvedOperations: 0,
			readinessReceipt: "result-recorded",
		});
		await expect(reopened.locator(".recovery-notice")).toContainText(
			"Core recorded a successful result for the matched readiness probe.",
		);
		await reopened.getByRole("button", { name: "Debug", exact: true }).click();
		await expect(reopened.locator(".restart-evidence-log")).toContainText(
			"Core recorded a successful result for the matched readiness probe.",
		);
		assert.deepEqual(await fs.readFile(journal), journalBefore);
		assert.deepEqual(await fs.readFile(writer), writerBefore);
		provider.verify();
		assert.equal(provider.requests.length, offset + 2);
	} finally {
		provider.beforeReply(undefined);
		finishReply();
		await app?.close();
	}
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
		await confirmTestDisplay(app, "before interruption");
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
		const active = (await snapshot(page)).active;
		const saved = active.hostRecovery;
		assert.equal(saved.executorOwner, owner);
		assert.equal(saved.readinessImage, imageId);
		const core = path.join(path.dirname(chat.cwd), "core");
		const journal = path.join(
			core,
			"runs",
			active.sessionId,
			saved.orbitRunId,
			"events.jsonl",
		);
		const ownerEvidence = path.join(
			core,
			"sessions",
			".coordination",
			`${active.sessionId}.owner`,
		);
		await killFixtureApp(app);
		app = undefined;
		assert.equal(await waitProbeRunning(env, owner), child);
		const [journalBefore, ownerBefore] = await Promise.all([
			fs.readFile(journal),
			fs.stat(ownerEvidence),
		]);
		assert.match(journalBefore.toString("utf8"), /"kind":"operation-intent"/);
		assert.equal(
			JSON.parse(
				await fs.readFile(
					path.join(`${base}-host-agent-native-v2`, "registry", "state.json"),
					"utf8",
				),
			).active.hostReadinessReceipt,
			undefined,
		);

		app = await launch(executablePath, base, port, env, true, false);
		const reopened = await app.firstWindow();
		await confirmTestDisplay(app, "after relaunch");
		const state = await snapshot(reopened);
		assert.equal(state.executionBackend, "host-readonly");
		assert.equal(state.executionReadinessProbe, undefined);
		await assertProbeTerminated(env, owner, child);
		await assertRetainedRecovery(reopened, chat, owner);
		const notice = reopened.locator(".recovery-notice");
		await expect(notice).toContainText(
			"No end record was found in the run journal.",
		);
		await expect(notice).toContainText(
			"Workspace changes have not been verified.",
		);
		await expect(notice).not.toContainText("saved readiness probe report");
		for (const observation of [state, await snapshot(reopened)]) {
			assert.deepEqual(observation.active.hostRecovery, saved);
			assert.equal(observation.active.hostReadinessReceipt, undefined);
			assert.deepEqual(observation.hostRestartDiagnostic, {
				journal: "open",
				unresolvedOperations: 1,
			});
		}
		assert.deepEqual(await fs.readFile(journal), journalBefore);
		const ownerAfter = await fs.stat(ownerEvidence);
		assert.equal(ownerAfter.ino, ownerBefore.ino);
		assert.equal(ownerAfter.mtimeMs, ownerBefore.mtimeMs);
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
		for (const conflicting of [false, true]) {
			await exerciseRestartBeforeResult(
				executablePath,
				path.join(
					scratch,
					conflicting ? "restart-with-conflict" : "restart-before-result",
				),
				address.port,
				env,
				provider,
				productionId,
				conflicting,
			);
		}
		await exerciseRestartAfterReceipt(
			executablePath,
			path.join(scratch, "restart-with-receipt"),
			address.port,
			env,
			provider,
			productionId,
		);
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
			"Packaged Orbit App: fixed readiness preview, approval, cancellation, restart with pending, completed, conflicting, or absent evidence, missing image refusal, and legacy opt-out verified.",
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

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	createDockerHostWriter,
	HostAgentRun,
	type HostReader,
	type HostWriter,
} from "../src/host-agent";
import type { HostApprovalAttempt, HostRecoveryIdentity } from "../src/types";
import { command, dockerPath } from "../src/worker";
import {
	HostCoreNames,
	hostRepository,
	acquireHostSources,
} from "../src/host-core";
import { openHostAgentProfile } from "../src/host-profile";
import { encodeWorkspaceRequest } from "../src/workspace-request";

import {
	createDockerHostCommandProbe,
	readinessCommand,
	readinessProfile,
	stopWorkspaceReadiness,
	type HostCommandProbe,
} from "../src/workspace-readiness";

async function fixture(t: import("node:test").TestContext) {
	const base = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-fixture-")),
	);
	t.after(async () => fs.rm(base, { recursive: true, force: true }));
	const legacy = path.join(base, "legacy");
	await fs.mkdir(legacy);
	await fs.writeFile(path.join(legacy, "example"), "legacy untouched");
	const root = openHostAgentProfile(legacy);
	assert.equal(openHostAgentProfile(legacy), root);
	assert.equal(
		await fs.readFile(path.join(legacy, "example"), "utf8"),
		"legacy untouched",
	);
	const project = randomUUID();
	const workspace = path.join(root, "projects", project, "workspace");
	const core = path.join(root, "projects", project, "core");
	await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
	const catalogCalls: string[] = [];
	const names = new HostCoreNames(root, {
		async call(dir) {
			catalogCalls.push(dir);
			return { name: "Fixture", revision: 1 };
		},
	});
	await names.call(core, { command: "create-project" });
	const sessionId = randomUUID();
	await names.call(core, {
		command: "create-session",
		sessionId,
		hostWorkspace: workspace,
	});
	t.after(async () => names.close());
	assert.deepEqual(catalogCalls, [path.join(root, "catalog")]);
	return { root, workspace, core, names, sessionId };
}

function completion(name?: string, args?: unknown) {
	return {
		id: "fixture",
		object: "chat.completion",
		created: 0,
		model: "gpt-4o",
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		choices: [
			{
				index: 0,
				finish_reason: name ? "tool_calls" : "stop",
				message: name
					? {
							role: "assistant",
							content: null,
							refusal: null,
							tool_calls: [
								{
									id: `call_${randomUUID().replaceAll("-", "")}`,
									type: "function",
									function: { name, arguments: JSON.stringify(args) },
								},
							],
						}
					: {
							role: "assistant",
							content: "Host fixture completed",
							refusal: null,
						},
			},
		],
	};
}

test("isolated host-profile marker refuses unmarked, pre-existing directories", async (t) => {
	const base = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-profile-fixture-"),
	);
	t.after(async () => fs.rm(base, { recursive: true, force: true }));
	const target = path.join(base, "legacy-host-agent-native-v2");
	await fs.mkdir(target, { mode: 0o700 });
	await fs.writeFile(path.join(target, "sentinel"), "keep");
	assert.throws(
		() => openHostAgentProfile(path.join(base, "legacy")),
		/unmarked or unsafe/,
	);
	assert.deepEqual(await fs.readdir(target), ["sentinel"]);
});

test("real Core runs on the host with exactly four Docker read tools; merged settings cannot open Bash, writes or MCP", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(
		path.join(f.workspace, "note.txt"),
		"There is no local fallback.",
	);
	await fs.mkdir(path.join(f.workspace, ".orbit"));
	// Inert fixture; the Core host must not construct an MCP process here.
	await fs.writeFile(
		path.join(f.workspace, ".orbit/settings.json"),
		JSON.stringify({
			tools: { profile: "coding", include: ["bash", "write", "edit"] },
			mcp: {
				servers: {
					harmlessFixture: { command: process.execPath, args: ["--version"] },
				},
			},
		}),
	);
	const artifact = `sha256:${"c".repeat(64)}`;
	const frames: Array<{ name: string; target: string }> = [];
	const reaped: string[] = [];
	const reader: HostReader = {
		admit: async () => artifact,
		read: async (_parent, workspace, image, op) => {
			assert.equal(workspace, f.workspace);
			assert.equal(image, artifact);
			frames.push(JSON.parse(encodeWorkspaceRequest(workspace, op)));
			return {
				content: [{ type: "text", text: "synthetic Docker observation" }],
			};
		},
		stop: async (parent) => {
			reaped.push(parent);
		},
	};
	const wire: any[] = [];
	const events: any[] = [];
	const bindingFile = path.join(f.root, "test-binding.json");
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Synthetic isolated read.",
			async recordRecoveryIdentity(identity) {
				await fs.writeFile(bindingFile, JSON.stringify(identity));
			},
		},
		(e) => events.push(e),
		async (route, body) => {
			assert.equal(route, "openai-chat");
			const binding: HostRecoveryIdentity = JSON.parse(
				await fs.readFile(bindingFile, "utf8"),
			);
			assert.equal(binding.executorOwner, run.name);
			assert.equal(binding.readerImage, artifact);
			assert.equal(
				binding.storagePairId,
				(await hostRepository(f.core)).scope(f.sessionId).pairId,
			);
			const eventsFile = path.join(
				f.core,
				"runs",
				f.sessionId,
				binding.orbitRunId,
				"events.jsonl",
			);
			assert.match(
				await fs.readFile(eventsFile, "utf8"),
				/"kind":"run-admitted"/,
			);
			wire.push(body);
			switch (wire.length) {
				case 1:
					return completion("read", { path: "note.txt" });
				case 2:
					return completion("write", {
						path: "should-not-exist.txt",
						content: "not written",
					});
				case 3:
					return completion("bash", { command: "printf 'not executed'" });
				default:
					return completion();
			}
		},
		reader,
	);
	await run.start();
	await run.confirmGone();
	assert.deepEqual(
		wire[0].tools.map((tool: any) => tool.function.name).sort(),
		["glob", "grep", "list", "read"],
	);
	assert.match(JSON.stringify(wire[1]), /synthetic Docker observation/);
	assert.deepEqual(
		frames.map((op) => [op.name, op.target]),
		[["read", "/workspace/note.txt"]],
	);
	assert.deepEqual(reaped, [run.name]);
	assert.equal(
		events.find((event) => event.type === "result")?.data?.runtime?.outcome,
		"completed",
	);
	assert.equal(
		events.some((event) => event.type === "approval"),
		false,
	);
	await assert.rejects(
		fs.access(path.join(f.workspace, "should-not-exist.txt")),
		{ code: "ENOENT" },
	);
	const repo = await hostRepository(f.core);
	const found = await repo.findById(f.sessionId);
	assert.equal(found?.cwd, f.workspace);
	assert.equal(found?.originator, "orbit-app-host-v1");
	const lease = await acquireHostSources(f.core, [f.sessionId]);
	try {
		assert.ok(
			lease.captures[0]?.messages.some(
				(message) => message.text === "Host fixture completed",
			),
		);
	} finally {
		await lease.release();
	}
});

async function hostReadinessScenario(
	t: import("node:test").TestContext,
	probe: HostCommandProbe,
	mode: "approve" | "deny" | "drift",
) {
	const f = await fixture(t);
	const approvals: Array<Record<string, unknown>> = [];
	const replies: Promise<unknown>[] = [];
	const requests: any[] = [];
	const events: any[] = [];
	const artifact = await probe.admit();
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Synthetic fixed readiness probe only.",
		},
		(event) => {
			events.push(event);
			if (event.type === "approval") {
				const data = event.data as Record<string, unknown>;
				approvals.push(data);
				replies.push(run.approve(data.id, mode !== "deny"));
			}
		},
		async (_route, body) => {
			requests.push(body);
			if (requests.length === 1)
				return completion("bash", {
					command: "printf 'different harmless text'",
				});
			if (
				requests.length === 2 ||
				(requests.length === 3 && mode === "approve")
			)
				return completion("bash", { command: readinessCommand });
			return completion();
		},
		{
			admit: async () => `sha256:${"c".repeat(64)}`,
			read: async () => assert.fail("No reader was requested"),
			stop: async () => {},
		},
		undefined,
		probe,
	);
	await run.start();
	await Promise.all(replies);
	await run.confirmGone();
	assert.deepEqual(
		requests[0].tools.map((tool: any) => tool.function.name).sort(),
		["bash", "glob", "grep", "list", "read"],
	);
	assert.equal(approvals.length, 1);
	const preview = approvals[0].preview as any;
	assert.equal(preview.command, readinessCommand);
	assert.equal(preview.cwd, f.workspace);
	assert.equal(preview.timeoutSeconds, 12);
	assert.equal(preview.commandProfile.revision, artifact);
	assert.equal(preview.commandProfile.network, "none");
	assert.equal(preview.commandProfile.workspace, "read-only");
	assert.match(preview.execution, /fixed Docker readiness probe/i);
	assert.deepEqual(await fs.readdir(f.workspace), []);
	if (mode === "approve") {
		assert.match(JSON.stringify(requests[2]), /workspace command ready/);
		assert.equal(
			events.find((e) => e.type === "result")?.data?.runtime?.outcome,
			"completed",
		);
	}
}

test("Host Core asks only for the exact readiness probe; denial and post-approval rejection never dispatch", async (t) => {
	const image = `sha256:${"d".repeat(64)}`;
	for (const mode of ["approve", "deny", "drift"] as const) {
		let executions = 0;
		await hostReadinessScenario(
			t,
			{
				admit: async () => image,
				revalidate: async (selected) => selected === image && mode !== "drift",
				execute: async () => {
					executions++;
					return {
						status: "exited",
						exitCode: 0,
						stdout: "workspace command ready\n",
						stderr: "",
						text: "workspace command ready",
					};
				},
				stop: async () => {},
			},
			mode,
		);
		assert.equal(executions, mode === "approve" ? 1 : 0);
	}
});

test("real Docker Host readiness uses the approved immutable image and reaps its fixed probe", {
	skip: process.env.ORBIT_APP_TEST_READINESS_DOCKER !== "1",
}, async (t) => {
	const tag = `orbit-app-readiness-test:${randomUUID()}`;
	t.after(() => command(dockerPath, ["image", "rm", tag]).catch(() => {}));
	await command(
		dockerPath,
		["build", "--network", "none", "--tag", tag, "worker/readiness"],
		120_000,
	);
	const probe = createDockerHostCommandProbe(tag);
	const parents: string[] = [];
	await hostReadinessScenario(
		t,
		{
			...probe,
			execute: (...args) => {
				parents.push(args[0]);
				return probe.execute(...args);
			},
		},
		"approve",
	);
	assert.equal(parents.length, 1);
	const id = parents[0].replace(/^orbit-app-/, "");
	const alive = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`name=^/orbit-app-workspace-${id}-probe$`,
		"--format",
		"{{.ID}}",
	]);
	assert.equal(alive.trim(), "");
});

test("fixed readiness transport rejects changed bindings and never removes a foreign container", async () => {
	const revision = `sha256:${"d".repeat(64)}`;
	const parent = `orbit-app-${randomUUID()}`;
	const workspace = path.resolve(os.tmpdir(), "synthetic-workspace");
	const profile = readinessProfile(revision);
	const op = {
		name: "bash",
		effect: "command",
		version: 1,
		cwd: workspace,
		target: workspace,
		timeoutMs: profile.timeoutMs,
		profile,
		input: { command: readinessCommand, timeoutSeconds: 12 },
	} as const;
	const id = "a".repeat(64);
	const calls: string[][] = [];
	const transport = async (_exe: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "ps") return id;
		if (args[0] === "inspect") return `orbit-app-${randomUUID()}`;
		return assert.fail("A foreign container must not be removed");
	};
	let invocations = 0;
	const probe = createDockerHostCommandProbe(
		"unused",
		transport,
		async (_exe, args) => {
			invocations++;
			assert.ok(args.includes("--pull=never"));
			assert.ok(args.includes("none"));
			assert.ok(args.includes("--read-only"));
			assert.deepEqual(
				args.filter((a) => a.startsWith("type=bind,src=")),
				[
					`type=bind,src=${workspace},dst=/workspace,readonly,bind-recursive=disabled`,
				],
			);
			assert.deepEqual(args.slice(-2), [revision, "/opt/orbit-readiness.mjs"]);
			return JSON.stringify({
				exitCode: 0,
				stdout: "workspace command ready\n",
			});
		},
	);
	const signal = new AbortController().signal;
	assert.deepEqual(
		await probe.execute(
			parent,
			workspace,
			revision,
			{
				...op,
				input: { ...op.input, command: "printf 'different harmless text'" },
			},
			signal,
		),
		{ status: "unknown" },
	);
	assert.deepEqual(
		await probe.execute(parent, workspace, revision, op, AbortSignal.abort()),
		{ status: "unknown" },
	);
	assert.equal(invocations, 0);
	await assert.rejects(
		probe.execute(parent, workspace, revision, op, signal),
		/ownership mismatch/,
	);
	assert.equal(invocations, 1);
	assert.deepEqual(
		calls.map((args) => args[0]),
		["ps", "inspect"],
	);
	await assert.rejects(
		stopWorkspaceReadiness("invalid-owner", transport),
		/Invalid readiness owner/,
	);
});

test("real Docker Host readiness cancellation stops its owned child without replay", {
	skip: process.env.ORBIT_APP_TEST_READINESS_DOCKER !== "1",
}, async (t) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-readiness-cancel-")),
	);
	const context = path.join(root, "image");
	const workspace = path.join(root, "workspace");
	await fs.mkdir(context);
	await fs.mkdir(workspace);
	const tag = `orbit-app-readiness-cancel-test:${randomUUID()}`;
	const parent = `orbit-app-${randomUUID()}`;
	t.after(async () => {
		await stopWorkspaceReadiness(parent).catch(() => {});
		await command(dockerPath, ["image", "rm", tag]).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	});
	// Only this synthetic test image delays. Production never runs project code.
	await fs.writeFile(
		path.join(context, "Dockerfile"),
		[
			"FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c",
			'LABEL org.cybergarage.orbit-app.workspace-readiness="1"',
			"COPY fixture.mjs /opt/orbit-readiness.mjs",
			"USER node",
			"",
		].join("\n"),
	);
	await fs.writeFile(
		path.join(context, "fixture.mjs"),
		"setTimeout(() => {}, 20000);\n",
	);
	await command(
		dockerPath,
		["build", "--network", "none", "--tag", tag, context],
		120_000,
	);
	const probe = createDockerHostCommandProbe(tag);
	const revision = await probe.admit();
	const profile = readinessProfile(revision);
	const controller = new AbortController();
	const owned = parent.replace(/^orbit-app-/, "");
	const running = () =>
		command(
			dockerPath,
			[
				"ps",
				"--filter",
				`name=^/orbit-app-workspace-${owned}-probe$`,
				"--format",
				"{{.ID}}",
			],
			1000,
		);
	const pending = probe.execute(
		parent,
		workspace,
		revision,
		{
			name: "bash",
			effect: "command",
			version: 1,
			cwd: workspace,
			target: workspace,
			timeoutMs: profile.timeoutMs,
			profile,
			input: { command: readinessCommand, timeoutSeconds: 12 },
		},
		controller.signal,
	);
	try {
		const deadline = performance.now() + 3500;
		while (!(await running()).trim()) {
			assert.ok(
				performance.now() < deadline,
				"The synthetic child did not start",
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	} finally {
		controller.abort();
	}
	assert.deepEqual(await pending, { status: "unknown" });
	assert.equal((await running()).trim(), "");
	assert.deepEqual(await fs.readdir(workspace), []);
});

test("stale or missing Docker backend fails before any model or host file operation", async (t) => {
	const f = await fixture(t);
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Never dispatched.",
		},
		() => {},
		async () => assert.fail("provider cannot run after failed admission"),
		{
			admit: async () => {
				throw new Error("stale reader image");
			},
			read: async () => assert.fail("read cannot run after failed admission"),
			stop: async () => assert.fail("no child was admitted"),
		},
	);
	await assert.rejects(run.start(), /stale reader image/);
	await run.confirmGone();
});

test("temporary catalog helper is shaped without a state or workspace mount", async (t) => {
	const f = await fixture(t);
	const catalog = path.join(f.root, "catalog");
	await fs.mkdir(catalog, { recursive: true, mode: 0o700 });
	const { runMetadataHelper } = await import("../src/metadata-helper");
	let createCalls = 0;
	const transport = {
		async command(args: string[]) {
			if (args[0] !== "create") return "";
			createCalls++;
			assert.deepEqual(
				args.flatMap((arg, index) =>
					arg === "--mount" ? [args[index + 1]] : [],
				),
				[`type=bind,src=${catalog},dst=/catalog`],
			);
			assert.equal(args.at(-1), "/opt/worker/names.mjs");
			throw new Error("Stop after inspecting synthetic create args");
		},
		start() {
			return assert.fail("No synthetic catalog child starts in this test");
		},
	};
	await assert.rejects(
		runMetadataHelper(
			f.root,
			catalog,
			{ command: "create-project" },
			{ catalogOnly: true, transport },
		),
		/after inspecting synthetic create args/,
	);
	await assert.rejects(
		runMetadataHelper(
			f.root,
			f.core,
			{ command: "create-session" },
			{ catalogOnly: true, transport },
		),
		/cannot access sessions/,
	);
	assert.equal(createCalls, 1);
});

// Local synthetic files only. Optional Docker tests use a unique tag and
// only the fixture's selected workspace, never a real profile or model.
const writerImage = `sha256:${"d".repeat(64)}`;
const fixtureReader: HostReader = {
	admit: async () => `sha256:${"c".repeat(64)}`,
	read: async () => assert.fail("No reader dispatch was requested"),
	stop: async () => {},
};

function mutationRun(
	f: Awaited<ReturnType<typeof fixture>>,
	writer: HostWriter,
	operations: ReadonlyArray<readonly [string, unknown]>,
	decide: (run: HostAgentRun, id: string, i: number) => Promise<void>,
	recordApprovalAttempt?: (attempt: HostApprovalAttempt) => Promise<void>,
) {
	let modelCalls = 0;
	let approvals = 0;
	const results: Array<{
		outcome: string;
		operations: Array<{ status: string }>;
	}> = [];
	const replies: Promise<void>[] = [];
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Synthetic Host Agent file-change test.",
			recordApprovalAttempt,
		},
		(event) => {
			if (event.type === "approval") {
				const request = event.data as {
					id: string;
					sessionId: string;
					responderScope: string;
					digest: string;
				};
				assert.equal(request.sessionId, f.sessionId);
				assert.equal(request.responderScope, "desktop-owner");
				assert.ok(request.digest);
				const reply = Promise.resolve().then(() =>
					decide(run, request.id, ++approvals),
				);
				void reply.catch(() => run.stop().catch(() => {}));
				replies.push(reply);
			} else if (event.type === "result") {
				results.push(
					(event.data as { runtime: (typeof results)[number] }).runtime,
				);
			}
		},
		async (_route, body, signal) => {
			signal.throwIfAborted();
			const { tools } = body as {
				tools: Array<{ function: { name: string } }>;
			};
			assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [
				"edit",
				"glob",
				"grep",
				"list",
				"read",
				"write",
			]);
			const step = operations[modelCalls++];
			return step ? completion(...step) : completion();
		},
		fixtureReader,
		writer,
	);
	return { run, results, replies };
}

test("host writer uses exact prepared digests, denies without dispatch, and rejects stale replies", async (t) => {
	const f = await fixture(t);
	const note = path.join(f.workspace, "note.txt");
	await fs.writeFile(note, "before");
	const frames: Array<ReturnType<typeof JSON.parse>> = [];
	const reaped: string[] = [];
	const attemptsFile = path.join(f.root, "test-approval.json");
	const { run, results, replies } = mutationRun(
		f,
		{
			admit: async () => writerImage,
			async mutate(_parent, workspace, image, op) {
				assert.equal(workspace, f.workspace);
				assert.equal(image, writerImage);
				assert.equal(op.target, note);
				const saved: HostApprovalAttempt = JSON.parse(
					await fs.readFile(attemptsFile, "utf8"),
				);
				assert.match(saved.digest, /^[a-f0-9]{64}$/);
				assert.ok(saved.approvalId && saved.operationId);
				frames.push(JSON.parse(encodeWorkspaceRequest(workspace, op)));
				return {
					content: [{ type: "text", text: "synthetic acknowledgment" }],
				};
			},
			async stop(owner) {
				reaped.push(owner);
			},
		},
		[
			["write", { path: "denied.txt", content: "do not write" }],
			["edit", { path: "note.txt", oldText: "before", newText: "after" }],
		],
		async (r, id, i) => {
			await assert.rejects(r.approve(randomUUID(), true), /no longer pending/);
			assert.equal(await fs.readFile(note, "utf8"), "before");
			await r.approve(id, i === 2);
			await assert.rejects(r.approve(id, true), /no longer pending/);
		},
		async (attempt) => {
			// wx proves a denial, mismatched click or stale click never writes another attempt.
			await fs.writeFile(attemptsFile, JSON.stringify(attempt), { flag: "wx" });
		},
	);
	await run.start();
	await Promise.all(replies);
	await run.confirmGone();
	assert.equal(frames.length, 1);
	assert.equal(frames[0].name, "edit");
	assert.equal(frames[0].cwd, "/workspace");
	assert.equal(frames[0].target, "/workspace/note.txt");
	assert.equal(frames[0].input.path, "/workspace/note.txt");
	assert.equal(
		frames[0].preimageSha256,
		createHash("sha256").update("before").digest("hex"),
	);
	assert.equal(
		frames[0].resultSha256,
		createHash("sha256").update("after").digest("hex"),
	);
	assert.equal(
		await fs.readFile(note, "utf8"),
		"before",
		"No local executor fallback",
	);
	await assert.rejects(fs.stat(path.join(f.workspace, "denied.txt")), {
		code: "ENOENT",
	});
	assert.deepEqual(reaped, [run.name]);
	assert.deepEqual(
		results[0]?.operations.map((op) => op.status),
		["denied", "succeeded"],
	);
});

test("cancelled approval cannot open the workspace writer", async (t) => {
	const f = await fixture(t);
	const { run, replies } = mutationRun(
		f,
		{
			admit: async () => writerImage,
			mutate: async () => assert.fail("A cancelled approval cannot dispatch"),
			stop: async () => {},
		},
		[["write", { path: "cancelled.txt", content: "not written" }]],
		async (r, id) => {
			void r.stop().catch(() => {});
			await assert.rejects(r.approve(id, true), /no longer pending/);
		},
	);
	await run.start();
	await Promise.all(replies);
	await run.confirmGone();
	await assert.rejects(fs.stat(path.join(f.workspace, "cancelled.txt")), {
		code: "ENOENT",
	});
});

test("a Host approval persistence failure cannot dispatch a workspace write", async (t) => {
	const f = await fixture(t);
	const { run, replies } = mutationRun(
		f,
		{
			admit: async () => writerImage,
			mutate: async () => assert.fail("An unrecorded approval cannot dispatch"),
			stop: async () => {},
		},
		[["write", { path: "not-dispatched.txt", content: "not written" }]],
		async (r, id) => {
			await assert.rejects(r.approve(id, true), /recording failed/);
			void r.stop().catch(() => {});
		},
		async () => {
			throw new Error("Approval attempt recording failed");
		},
	);
	await run.start().catch(() => {});
	await Promise.all(replies);
	await run.confirmGone();
	await assert.rejects(fs.stat(path.join(f.workspace, "not-dispatched.txt")), {
		code: "ENOENT",
	});
});

test("lost writer acknowledgment remains unknown with no second dispatch or host fallback", async (t) => {
	const f = await fixture(t);
	let dispatches = 0;
	const { run, results, replies } = mutationRun(
		f,
		{
			admit: async () => writerImage,
			async mutate() {
				dispatches++;
				throw new Error("Fixture lost its acknowledgment");
			},
			stop: async () => {},
		},
		[["write", { path: "uncertain.txt", content: "not written locally" }]],
		async (r, id) => {
			await r.approve(id, true);
		},
	);
	await run.start().catch(() => {}); // Core can retain the guard for an uncertain writer.
	await Promise.all(replies);
	assert.equal(dispatches, 1);
	assert.equal(results[0]?.outcome, "incomplete");
	assert.equal(results[0]?.operations[0]?.status, "unknown");
	await assert.rejects(run.confirmGone(), /ownership remains/);
	await assert.rejects(fs.stat(path.join(f.workspace, "uncertain.txt")), {
		code: "ENOENT",
	});
});

test("host writer rejects stale image admission before provider dispatch", async (t) => {
	const f = await fixture(t);
	const writer = createDockerHostWriter(
		"fixture-writer",
		async (_exe, args) => {
			assert.match(
				args.join(" "),
				/org\.cybergarage\.orbit-app\.workspace-runner/,
			);
			return `${writerImage} <no value>`;
		},
	);
	const { run, replies } = mutationRun(f, writer, [], async () => {
		assert.fail("A stale writer cannot request approval");
	});
	await assert.rejects(run.start(), /standalone Docker writer/);
	await run.confirmGone();
	assert.deepEqual(replies, []);
});

test("Docker Host writer executes only approved changes and reaps owned containers", {
	skip: process.env.ORBIT_APP_TEST_HOST_WRITER_DOCKER !== "1",
	timeout: 120_000,
}, async (t) => {
	const f = await fixture(t);
	const tag = `orbit-app-host-writer-fixture:${randomUUID()}`;
	t.after(async () =>
		command(dockerPath, ["image", "rm", tag]).catch(() => {}),
	);
	await command(
		dockerPath,
		["build", "--network=none", "--tag", tag, "worker/workspace"],
		90_000,
	);
	const writer = createDockerHostWriter(tag);
	const artifact = await writer.admit();
	let containers = 0;
	let cancelOnCreate: (() => void) | undefined;
	const inspected = createDockerHostWriter(tag, async (exe, args, timeout) => {
		const result = await command(exe, args, timeout);
		if (args[0] !== "create") return result;
		const [created] = JSON.parse(
			await command(exe, ["inspect", result.trim()], 5_000),
		);
		assert.equal(created.Image, artifact);
		assert.equal(created.HostConfig.NetworkMode, "none");
		assert.equal(created.HostConfig.ReadonlyRootfs, true);
		assert.deepEqual(
			created.Mounts.map(
				(entry: { Type: string; Destination: string; RW: boolean }) => [
					entry.Type,
					entry.Destination,
					entry.RW,
				],
			),
			[["bind", "/workspace", true]],
		);
		assert.ok(
			args.includes(
				`type=bind,src=${f.workspace},dst=/workspace,bind-recursive=disabled`,
			),
		);
		assert.equal(args.filter((arg) => arg === "--mount").length, 1);
		assert.ok(!args.includes("--env-file"));
		assert.ok(created.Config.Env.includes("HTTP_PROXY="));
		assert.ok(created.Config.Env.includes("https_proxy="));
		assert.ok(
			created.Config.Env.filter((value: string) =>
				/^\w*_proxy=/i.test(value),
			).every((value: string) => value.endsWith("=")),
		);
		containers++;
		cancelOnCreate?.();
		return result;
	});
	const assertGone = async (name: string) => {
		const remaining = await command(dockerPath, [
			"ps",
			"-a",
			"--filter",
			`label=org.cybergarage.orbit-app.workspace-parent=${name}`,
			"--format",
			"{{.Names}}",
		]);
		assert.equal(remaining.trim(), "");
	};
	const first = mutationRun(
		f,
		inspected,
		[
			["write", { path: "note.txt", content: "before" }],
			["write", { path: "denied.txt", content: "denied" }],
			["edit", { path: "note.txt", oldText: "before", newText: "after" }],
			[
				"write",
				{
					path: "missing/file.txt",
					content: "no directory changes",
					createDirectories: true,
				},
			],
		],
		(run, id, i) => run.approve(id, i !== 2),
	);
	t.after(() => writer.stop(first.run.name));
	await first.run.start();
	await Promise.all(first.replies);
	await first.run.confirmGone();
	assert.deepEqual(
		first.results[0]?.operations.map((op) => op.status),
		["succeeded", "denied", "succeeded", "failed"],
	);
	assert.equal(
		await fs.readFile(path.join(f.workspace, "note.txt"), "utf8"),
		"after",
	);
	assert.deepEqual(await fs.readdir(f.workspace), ["note.txt"]);
	assert.equal(containers, 3);
	await assertGone(first.run.name);

	const second = mutationRun(
		f,
		inspected,
		[["write", { path: "cancelled.txt", content: "do not start" }]],
		(run, id) => run.approve(id, true),
	);
	t.after(() => writer.stop(second.run.name));
	cancelOnCreate = () => {
		void second.run.stop().catch(() => {});
	};
	await second.run.start().catch(() => {});
	await Promise.all(second.replies);
	assert.equal(containers, 4);
	await assertGone(second.run.name);
	assert.deepEqual(await fs.readdir(f.workspace), ["note.txt"]);
});

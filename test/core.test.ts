import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, identifier } from "../src/store";
import {
	dockerArgs,
	modelRequest,
	Worker,
	verifySessionWriterReleased,
} from "../src/worker";
import { Supervisor } from "../src/supervisor";
const temporaryDirectories: string[] = [];
after(async () => {
	await Promise.all(
		temporaryDirectories.map((root) =>
			fs.rm(root, { recursive: true, force: true }),
		),
	);
});
async function directory() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-test-"));
	temporaryDirectories.push(root);
	return root;
}
async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline) throw Error("Lifecycle condition timed out");
		await new Promise((r) => setTimeout(r, 2));
	}
}
test("project paths reject traversal; projects have independent workspaces", async () => {
	const root = await directory();
	const store = new Store(root);
	await store.init();
	const a = await store.createProject("A"),
		b = await store.createProject("B");
	assert.notEqual(store.workspace(a.id), store.workspace(b.id));
	assert.throws(() => identifier("../../.ssh"));
	assert.throws(() => store.project(randomUUID()));
});
test("atomic concurrent writes and interrupted state survive restart", async () => {
	const root = await directory();
	const store = new Store(root);
	await store.init();
	const p = await store.createProject("A");
	const s = await store.createSession(p.id);
	s.status = "running";
	await Promise.all([store.save(), store.save(), store.save()]);
	const restored = new Store(root);
	await restored.init();
	assert.equal(restored.session(p.id, s.id).status, "interrupted");
	assert.equal(restored.session(p.id, s.id).events.at(-1)?.type, "interrupted");
});
test("worker args expose only project workspace and core, with no network or elevated capabilities", () => {
	const args = dockerArgs(
		"orbit-test",
		"/tmp/project/workspace",
		"/tmp/project/core",
	);
	assert.equal(args[args.indexOf("--network") + 1], "none");
	assert.ok(args.includes("--read-only"));
	assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
	assert.ok(args.includes("no-new-privileges"));
	assert.equal(args.filter((a) => a.startsWith("type=bind")).length, 2);
	assert.ok(!args.join(" ").includes("docker.sock"));
	assert.ok(!args.join(" ").includes("privileged"));
});
test("host model gateway rejects arbitrary routes and clamps model and resource parameters", async () => {
	const previous = globalThis.fetch;
	let body: any;
	globalThis.fetch = async (_url, options) => {
		body = JSON.parse(String(options?.body));
		return new Response("{}", { status: 200 });
	};
	try {
		await assert.rejects(
			modelRequest("pull", {}, "gemma4:12b", new AbortController().signal),
		);
		await modelRequest(
			"chat",
			{ model: "remote", stream: true, options: { num_ctx: 999999 } },
			"gemma4:12b",
			new AbortController().signal,
		);
		assert.equal(body.model, "gemma4:12b");
		assert.equal(body.stream, false);
		assert.equal(body.options.num_ctx, 8192);
		assert.equal(body.options.num_predict, 1024);
	} finally {
		globalThis.fetch = previous;
	}
});
test("single worker admission, cancellation and duplicate request rejection", async () => {
	let finish: () => void = () => {};
	let count = 0;
	const root = await directory();
	const sup = new Supervisor(
		root,
		() => {},
		() =>
			({
				start: () => {
					count++;
					return new Promise<void>((r) => {
						finish = r;
					});
				},
				stop: async () => finish(),
				approve: () => {},
				confirmGone: async () => {},
			}) as unknown as Worker,
	);
	await sup.init();
	sup.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["gemma4:12b"],
		detail: [],
	});
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const input = {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Task",
		model: "gemma4:12b",
		requestId: randomUUID(),
	};
	await sup.submit(input);
	await assert.rejects(
		sup.submit({ ...input, requestId: randomUUID() }),
		/already active/,
	);
	assert.equal(count, 1);
	await sup.cancel();
	await waitFor(() => !sup.worker);
	await assert.rejects(sup.submit(input), /Duplicate/);
	assert.equal(s.status, "cancelled");
	await sup.submit({ ...input, requestId: randomUUID() });
	assert.equal(count, 2);
	await sup.cancel();
	await waitFor(() => !sup.worker);
});
test("durable schedules coalesce missed runs, disable correctly and never require an always-on Mac", async () => {
	const root = await directory();
	const sup = new Supervisor(root, () => {});
	await sup.init();
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const schedule: any = await sup.dispatch("schedule", {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Scheduled task",
		model: "gemma4:12b",
		nextAt: Date.now() + 60000,
		intervalMs: 3600000,
	});
	let runs = 0;
	sup.submit = async () => {
		runs++;
		return { accepted: true };
	};
	const now = Date.now() + 86400000;
	await sup.tick(now);
	await sup.tick(now);
	assert.equal(runs, 1);
	assert.equal(schedule.nextAt, now + 3600000);
	await sup.dispatch("disable-schedule", { id: schedule.id });
	await sup.tick(now + 7200000);
	assert.equal(runs, 1);
	const restored = new Store(root);
	await restored.init();
	assert.equal(restored.state.schedules[0].enabled, false);
});

test("cancel during health never starts a delayed worker", async () => {
	let release: () => void = () => {},
		started = 0;
	const sup = new Supervisor(
		await directory(),
		() => {},
		() =>
			({
				start: async () => {
					started++;
				},
				stop: async () => {},
				confirmGone: async () => {},
			}) as unknown as Worker,
	);
	await sup.init();
	sup.health = async () => {
		await new Promise<void>((r) => {
			release = r;
		});
		return {
			docker: true,
			ollama: true,
			image: true,
			models: ["gemma4:12b"],
			detail: [],
		};
	};
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const submission = sup.submit({
		projectId: p.id,
		sessionId: s.id,
		prompt: "Task",
		model: "gemma4:12b",
		requestId: randomUUID(),
	});
	await sup.cancel();
	release();
	await assert.rejects(submission, /cancelled/);
	assert.equal(started, 0);
	assert.equal(s.status, "cancelled");
});
test("expired and stale approvals cannot be forwarded", () => {
	const worker = new Worker(
		"/tmp/a",
		"/tmp/b",
		{ model: "gemma4:12b" },
		() => {},
	);
	worker.approval = { id: randomUUID(), expiresAt: Date.now() - 1 };
	assert.throws(() => worker.approve(worker.approval.id, true), /no longer/);
	assert.throws(() => worker.approve(randomUUID(), true), /no longer/);
});

test("new submissions stay blocked until prior container cleanup is confirmed", async () => {
	let finish: () => void = () => {},
		reclaim: () => void = () => {};
	let cleanupStarted = false;
	const sup = new Supervisor(
		await directory(),
		() => {},
		() =>
			({
				name: `orbit-app-${randomUUID()}`,
				start: () =>
					new Promise<void>((r) => {
						finish = r;
					}),
				stop: async () => finish(),
				confirmGone: () =>
					new Promise<void>((r) => {
						cleanupStarted = true;
						reclaim = r;
					}),
			}) as unknown as Worker,
	);
	await sup.init();
	sup.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["gemma4:12b"],
		detail: [],
	});
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const input = {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Task",
		model: "gemma4:12b",
		requestId: randomUUID(),
	};
	await sup.submit(input);
	finish();
	await waitFor(() => cleanupStarted);
	await assert.rejects(
		sup.submit({ ...input, requestId: randomUUID() }),
		/already active/,
	);
	reclaim();
	await waitFor(() => !sup.worker);
	assert.equal(sup.store.state.active, undefined);
});

test("moving a session retains Orbit storage and cwd, schedules follow membership and edits affect only new chats", async () => {
	const root = await directory(),
		store = new Store(root);
	await store.init();
	const a = await store.createProject("A"),
		b = await store.createProject("B");
	const session = await store.createSession(a.id);
	session.events.push({
		type: "result",
		at: new Date().toISOString(),
		data: { answer: "preserved" },
	});
	await fs.writeFile(
		path.join(store.core(a.id), "history-proof.json"),
		"original Orbit journal",
	);
	store.state.schedules.push({
		id: randomUUID(),
		projectId: a.id,
		sessionId: session.id,
		prompt: "task",
		model: "test",
		enabled: true,
		nextAt: Date.now() + 60000,
		intervalMs: 0,
	});
	const before = store.location(a.id, session.id);
	await store.moveSession({
		projectId: a.id,
		sessionId: session.id,
		targetProjectId: b.id,
	});
	assert.deepEqual(store.location(b.id, session.id), before);
	assert.equal(store.state.schedules[0].projectId, b.id);
	const nextDirectory = await directory();
	await store.editProject({
		projectId: b.id,
		name: "Edited B",
		directory: nextDirectory,
		instructions: "Use workspace guidance",
	});
	const newSession = await store.createSession(b.id);
	assert.equal(newSession.workspace, await fs.realpath(nextDirectory));
	assert.equal(session.workspace, before.workspace);
	await store.renameSession({
		projectId: b.id,
		sessionId: session.id,
		name: "Renamed",
	});
	const restored = new Store(root);
	await restored.init();
	assert.equal(restored.session(b.id, session.id).name, "Renamed");
	assert.equal(
		restored.session(b.id, session.id).events[0].data.answer,
		"preserved",
	);
	assert.equal(
		await fs.readFile(
			path.join(restored.location(b.id, session.id).core, "history-proof.json"),
			"utf8",
		),
		"original Orbit journal",
	);
});

test("active and recovery-pending sessions cannot move and legacy migration keeps a backup", async () => {
	const root = await directory(),
		p = randomUUID(),
		s = randomUUID(),
		target = randomUUID();
	const legacy = {
		projects: [
			{
				id: p,
				name: "Legacy",
				sessions: [{ id: s, name: "Old", status: "idle", events: [] }],
			},
			{ id: target, name: "Target", sessions: [] },
		],
		schedules: [],
	};
	await fs.writeFile(path.join(root, "state.json"), JSON.stringify(legacy));
	const store = new Store(root);
	await store.init();
	assert.deepEqual(
		JSON.parse(
			await fs.readFile(path.join(root, "state.pre-approved-ui.json"), "utf8"),
		),
		legacy,
	);
	const session = store.session(p, s);
	assert.equal(session.storageProjectId, p);
	assert.equal(session.workspace, store.workspace(p));
	session.status = "recovery-blocked";
	await assert.rejects(
		store.moveSession({ projectId: p, sessionId: s, targetProjectId: target }),
		/cannot be moved/,
	);
	session.status = "idle";
	store.state.active = { projectId: p, sessionId: s };
	await assert.rejects(
		store.moveSession({ projectId: p, sessionId: s, targetProjectId: target }),
		/cannot be moved/,
	);
	assert.equal(store.project(p).sessions.length, 1);
	assert.equal(store.project(target).sessions.length, 0);
	await assert.rejects(store.directory(os.homedir()), /cannot be worker/);
	await assert.rejects(store.directory("/etc"), /cannot be worker/);
});

test("schedule occurrence captures admission failures without fabricated answers and restart interrupts unfinished executions", async () => {
	const root = await directory(),
		sup = new Supervisor(root, () => {});
	await sup.init();
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const definition: any = await sup.dispatch("schedule", {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Real task",
		model: "missing",
		nextAt: Date.now() + 60000,
		intervalMs: 0,
	});
	sup.health = async () => ({
		docker: false,
		ollama: false,
		image: false,
		models: [],
		detail: [],
	});
	await sup.tick(definition.nextAt);
	const run = sup.store.state.executions?.[0];
	assert.ok(run);
	assert.equal(run.status, "failed");
	assert.equal(run.prompt, "Real task");
	assert.equal(run.answer, undefined);
	assert.equal(run.scheduleId, definition.id);
	assert.ok(run.events.some((e) => e.type === "error"));
	await sup.tick(definition.nextAt + 60000);
	assert.equal(sup.store.state.executions?.length, 1);
	delete run.endedAt;
	run.status = "running";
	await sup.store.save();
	const restored = new Store(root);
	await restored.init();
	assert.equal(restored.state.executions?.[0].status, "interrupted");
	assert.ok(restored.state.executions?.[0].endedAt);
});

test("scheduled worker events, approval decisions, result and duration are independently retained", async () => {
	let finish: () => void = () => {},
		emit: (e: any) => void = () => {};
	const sup = new Supervisor(
		await directory(),
		() => {},
		(_workspace, _core, _config, event) => {
			emit = event;
			return {
				name: `orbit-app-${randomUUID()}`,
				start: () =>
					new Promise<void>((r) => {
						finish = r;
					}),
				stop: async () => finish(),
				approve: () => {},
				confirmGone: async () => {},
			} as unknown as Worker;
		},
	);
	await sup.init();
	sup.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["fixture"],
		detail: [],
	});
	const p = await sup.store.createProject("P"),
		s = await sup.store.createSession(p.id);
	const definition: any = await sup.dispatch("schedule", {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Input",
		model: "fixture",
		nextAt: Date.now() + 60000,
		intervalMs: 0,
	});
	await sup.tick(definition.nextAt);
	emit({
		type: "approval",
		data: { id: "approval", preview: { command: "write" } },
	});
	await sup.dispatch("approve", { id: "approval", approve: false });
	emit({ type: "agent-event", data: { toolCall: { name: "write" } } });
	emit({
		type: "result",
		data: {
			answer: "Answer",
			runtime: { outcome: "completed", runId: "fixture-orbit-run" },
		},
	});
	finish();
	await waitFor(() => !sup.worker);
	const run = sup.store.state.executions?.[0];
	assert.ok(run);
	assert.equal(run.orbitRunId, "fixture-orbit-run");
	assert.equal(run.answer, "Answer");
	assert.equal(run.status, "completed");
	assert.ok(run.endedAt);
	assert.deepEqual(
		run.events.map((e) => e.type),
		["approval", "approval-decision", "agent-event", "result"],
	);
});

test("leftover Orbit writer evidence blocks recovery and is never deleted", async () => {
	const core = await directory(),
		id = randomUUID();
	await verifySessionWriterReleased(core, id);
	const dir = path.join(core, "sessions", ".coordination");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${id}.owner`),
		bytes = JSON.stringify({ pid: 1, token: randomUUID(), version: 1 });
	await fs.writeFile(file, bytes);
	await assert.rejects(
		verifySessionWriterReleased(core, id),
		/writer ownership remains/,
	);
	assert.equal(await fs.readFile(file, "utf8"), bytes);
});

test("late model RPC after stop receives cancellation rather than hanging the worker", async () => {
	const worker = new Worker("/tmp/a", "/tmp/b", { model: "fixture" }, () => {});
	const messages: any[] = [];
	worker.send = (message) => {
		messages.push(message);
	};
	worker.controller.abort();
	const id = randomUUID();
	await worker.rpc({ id, route: "chat", body: {} });
	assert.deepEqual(messages, [
		{ type: "rpc-result", id, error: "Worker cancelled" },
	]);
});

test("external workspaces require private user-owned paths and are revalidated before execution", async () => {
	const root = await directory(),
		store = new Store(root);
	await store.init();
	const external = await directory();
	assert.equal(await store.directory(external), await fs.realpath(external));
	const project = await store.createProject("Private", external),
		session = await store.createSession(project.id);
	assert.equal(
		await store.executionWorkspace(project.id, session.id),
		await fs.realpath(external),
	);
	await fs.chmod(external, 0o777);
	await assert.rejects(store.directory(external), /not group\/world writable/);
	await assert.rejects(
		store.executionWorkspace(project.id, session.id),
		/not group\/world writable/,
	);
	await fs.chmod(external, 0o700);
	const child = path.join(external, "child");
	await fs.mkdir(child, { mode: 0o700 });
	await fs.chmod(external, 0o770);
	await assert.rejects(store.directory(child), /not group\/world writable/);
	await fs.chmod(external, 0o700);
	const alias = path.join(root, "alias");
	await fs.symlink(external, alias);
	assert.equal(await store.directory(alias), await fs.realpath(external));
	const commaDirectory = path.join(root, "comma,directory");
	await fs.mkdir(commaDirectory, { mode: 0o700 });
	const commaAlias = path.join(root, "comma-alias");
	await fs.symlink(commaDirectory, commaAlias);
	await assert.rejects(
		store.directory(commaAlias),
		/Canonical working directory/,
	);
	const moved = `${external}-moved`;
	temporaryDirectories.push(moved);
	await fs.rename(external, moved);
	await fs.symlink(moved, external);
	await assert.rejects(
		store.executionWorkspace(project.id, session.id),
		/identity changed/,
	);
	const defaultProject = await store.createProject("Managed"),
		defaultSession = await store.createSession(defaultProject.id);
	assert.equal(
		await store.executionWorkspace(defaultProject.id, defaultSession.id),
		store.workspace(defaultProject.id),
	);
	await fs.chmod(store.workspace(defaultProject.id), 0o777);
	await assert.rejects(
		store.executionWorkspace(defaultProject.id, defaultSession.id),
		/not group\/world writable/,
	);
});

test("submission never reaches Docker admission after an external workspace becomes shared writable", async () => {
	let admitted = 0;
	const supervisor = new Supervisor(
		await directory(),
		() => {},
		() => {
			admitted++;
			throw new Error("Unexpected worker admission");
		},
	);
	await supervisor.init();
	supervisor.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["fixture"],
		detail: [],
	});
	const external = await directory(),
		project = await supervisor.store.createProject("External", external),
		session = await supervisor.store.createSession(project.id);
	await fs.chmod(external, 0o777);
	await assert.rejects(
		supervisor.submit({
			projectId: project.id,
			sessionId: session.id,
			prompt: "Task",
			model: "fixture",
			requestId: randomUUID(),
		}),
		/not group\/world writable/,
	);
	assert.equal(admitted, 0);
	assert.equal(supervisor.store.state.active, undefined);
	assert.equal(session.status, "idle");
});

async function cancellationFixture() {
	const emitters: Array<(event: any) => void> = [],
		finishes: Array<() => void> = [];
	const supervisor = new Supervisor(
		await directory(),
		() => {},
		(_workspace, _core, _config, emit) => {
			const index = emitters.push(emit) - 1;
			return {
				name: `orbit-app-${randomUUID()}`,
				start: () =>
					new Promise<void>((resolve) => {
						finishes[index] = resolve;
					}),
				stop: async () => {},
				confirmGone: async () => {},
			} as unknown as Worker;
		},
	);
	await supervisor.init();
	supervisor.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["fixture"],
		detail: [],
	});
	const project = await supervisor.store.createProject("Cancellation"),
		session = await supervisor.store.createSession(project.id);
	const submit = async () => {
		const requestId = randomUUID();
		await supervisor.submit({
			projectId: project.id,
			sessionId: session.id,
			requestId,
			prompt: "Task",
			model: "fixture",
		});
		return requestId;
	};
	const finish = async (index = 0) => {
		finishes[index]();
		await waitFor(() => !supervisor.worker);
	};
	return { supervisor, project, session, emitters, submit, finish };
}

test("requested cancellation classifies a cancelled model failure without rewriting the raw outcome", async () => {
	const f = await cancellationFixture(),
		requestId = await f.submit();
	await f.supervisor.cancel();
	await f.supervisor.cancel();
	f.emitters[0]({
		type: "model-cancelled",
		data: { reason: "host cancellation" },
	});
	f.emitters[0]({ type: "run", data: { phase: "running" } });
	assert.equal(f.session.status, "cancelling");
	f.emitters[0]({
		type: "result",
		data: {
			answer: "",
			runtime: { outcome: "failed", reason: "runtime-failed" },
		},
	});
	await f.finish();
	assert.equal(f.session.status, "cancelled");
	assert.equal(
		f.session.events.filter((e) => e.type === "cancel-requested").length,
		1,
	);
	assert.equal(
		f.session.events.find((e) => e.type === "cancel-requested")?.data.effective,
		true,
	);
	assert.equal(
		f.session.events.find((e) => e.type === "result")?.data.runtime.outcome,
		"failed",
	);
	assert.equal(
		f.session.events.find((e) => e.type === "result")?.requestId,
		requestId,
	);
	const restored = new Store(f.supervisor.store.root);
	await restored.init();
	assert.equal(
		restored.session(f.project.id, f.session.id).status,
		"cancelled",
	);
});

test("independent failure before or after cancellation stays failed", async () => {
	for (const earlier of [true, false]) {
		const f = await cancellationFixture();
		await f.submit();
		if (earlier) f.emitters[0]({ type: "error", data: "Disk failed" });
		await f.supervisor.cancel();
		if (!earlier) {
			f.emitters[0]({ type: "model-cancelled", data: {} });
			f.emitters[0]({ type: "error", data: "Disk failed" });
		}
		f.emitters[0]({
			type: "result",
			data: {
				answer: "",
				runtime: { outcome: "failed", reason: "disk error" },
			},
		});
		await f.finish();
		assert.equal(f.session.status, "failed");
		assert.ok(f.session.events.some((e) => e.data === "Disk failed"));
	}
});

test("a terminal result wins a late cancellation and success racing cancellation remains completed", async () => {
	for (const earlier of [true, false]) {
		const f = await cancellationFixture();
		await f.submit();
		const result = {
			type: "result",
			data: {
				answer: "DONE",
				runtime: { outcome: "completed", reason: "completed" },
			},
		};
		if (earlier) f.emitters[0](result);
		await f.supervisor.cancel();
		if (!earlier) f.emitters[0](result);
		await f.finish();
		assert.equal(f.session.status, "completed");
		assert.equal(f.session.answer, "DONE");
		assert.equal(
			f.session.events.find((e) => e.type === "cancel-requested")?.data
				.effective,
			!earlier,
		);
	}
});

test("late events from a cancelled worker cannot replace the next request's state or answer", async () => {
	const f = await cancellationFixture(),
		first = await f.submit();
	await f.supervisor.cancel();
	f.emitters[0]({ type: "model-cancelled", data: {} });
	f.emitters[0]({
		type: "result",
		data: {
			answer: "",
			runtime: { outcome: "failed", reason: "runtime-failed" },
		},
	});
	await f.finish();
	const second = await f.submit();
	f.emitters[0]({ type: "approval", data: { id: "stale" } });
	f.emitters[0]({
		type: "result",
		data: { answer: "STALE", runtime: { outcome: "failed" } },
	});
	assert.equal(f.session.status, "starting");
	assert.notEqual(f.session.answer, "STALE");
	f.emitters[1]({
		type: "result",
		data: {
			answer: "FRESH",
			runtime: { outcome: "completed", reason: "completed" },
		},
	});
	await f.finish(1);
	assert.equal(f.session.status, "completed");
	assert.equal(f.session.answer, "FRESH");
	assert.ok(
		f.session.events.some(
			(e) => e.requestId === first && e.data?.answer === "STALE",
		),
	);
	assert.ok(
		f.session.events.some(
			(e) => e.requestId === second && e.data?.answer === "FRESH",
		),
	);
});

test("budget and incomplete terminal outcomes are not hidden by cancellation", async () => {
	for (const outcome of ["budget-exceeded", "incomplete"]) {
		const f = await cancellationFixture();
		await f.submit();
		await f.supervisor.cancel();
		f.emitters[0]({ type: "model-cancelled", data: {} });
		f.emitters[0]({
			type: "result",
			data: { answer: "partial", runtime: { outcome, reason: outcome } },
		});
		await f.finish();
		assert.equal(f.session.status, outcome);
		assert.equal(
			f.session.events.find((e) => e.type === "result")?.data.runtime.outcome,
			outcome,
		);
	}
});

test("scheduled cancellation during health retains intent and cancellation classification", async () => {
	let release: () => void = () => {};
	let entered = false;
	const supervisor = new Supervisor(await directory(), () => {});
	await supervisor.init();
	const project = await supervisor.store.createProject(
			"Scheduled cancellation",
		),
		session = await supervisor.store.createSession(project.id);
	await supervisor.dispatch("schedule", {
		projectId: project.id,
		sessionId: session.id,
		prompt: "Task",
		model: "fixture",
		nextAt: Date.now() + 60000,
		intervalMs: 0,
	});
	supervisor.health = async () => {
		entered = true;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			docker: true,
			ollama: true,
			image: true,
			models: ["fixture"],
			detail: [],
		};
	};
	const ticking = supervisor.tick(Date.now() + 120000);
	await waitFor(() => entered);
	// Cancel only once admission has reached the pending health call.
	await supervisor.cancel();
	release();
	await ticking;
	const run = supervisor.store.state.executions?.[0];
	assert.equal(run?.status, "cancelled");
	assert.ok(run?.events.some((e) => e.type === "error"));
	assert.ok(run?.events.some((e) => e.type === "cancel-requested"));
});

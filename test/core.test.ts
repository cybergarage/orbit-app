import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, identifier } from "../src/store";
import { dockerArgs, modelRequest, Worker } from "../src/worker";
import { Supervisor } from "../src/supervisor";
async function directory() {
	return fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-test-"));
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
	await new Promise((r) => setTimeout(r, 20));
	await assert.rejects(sup.submit(input), /Duplicate/);
	assert.equal(s.status, "cancelled");
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
	await new Promise((r) => setTimeout(r, 10));
	await assert.rejects(
		sup.submit({ ...input, requestId: randomUUID() }),
		/already active/,
	);
	reclaim();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(sup.store.state.active, undefined);
});

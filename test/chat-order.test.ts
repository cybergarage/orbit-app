import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { orderedChats } from "../src/chat-order";
import { orderFixture, seedOrderFixture } from "./fixtures/order";

test("acceptance publishes before preflight and worker; rejection, schedule, move and restart preserve order", async (t) => {
	t.mock.method(Date, "now", () => 100);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-order-"));
	const snapshots: any[] = [];
	const f = orderFixture(root, (s) => snapshots.push(s));
	f.sup.store.state = seedOrderFixture();
	const [p, target] = f.sup.store.state.projects;
	const [a, b] = p.sessions;
	const input = {
		projectId: p.id,
		sessionId: b.id,
		prompt: "Hello",
		model: "fixture",
		requestId: randomUUID(),
	};
	try {
		await assert.rejects(f.sup.submit({ ...input, prompt: " " }));
		assert.equal(b.lastUserSubmission, undefined);
		const pending = f.sup.submit(input);
		assert.equal(snapshots.length, 1);
		assert.equal(f.starts(), 0);
		assert.equal(orderedChats(snapshots[0].projects[0].sessions)[0].id, b.id);
		await assert.rejects(
			f.sup.submit({ ...input, sessionId: a.id, requestId: randomUUID() }),
		);
		assert.equal(a.lastUserSubmission, undefined);
		// Wait until title interruption has yielded to the controlled health check.
		while (!f.healthReady()) await new Promise((r) => setTimeout(r, 2));
		f.release();
		await pending;
		f.finish();
		while (f.sup.worker) await new Promise((r) => setTimeout(r, 2));
		const rank = structuredClone(b.lastUserSubmission);
		await assert.rejects(f.sup.submit(input), /Duplicate/);
		assert.deepEqual(b.lastUserSubmission, rank);
		// A failed preflight still consumes the accepted request, even without a submission event.
		f.sup.health = async () => {
			throw Error("Model unavailable");
		};
		const failed = { ...input, sessionId: a.id, requestId: randomUUID() };
		await assert.rejects(f.sup.submit(failed), /Model unavailable/);
		await assert.rejects(f.sup.submit(failed), /Duplicate/);
		assert.equal(orderedChats(p.sessions)[0].id, a.id);
		const before = structuredClone(a.lastUserSubmission);
		f.sup.store.state.schedules.push({
			id: randomUUID(),
			projectId: p.id,
			sessionId: b.id,
			prompt: "scheduled",
			model: "fixture",
			nextAt: 0,
			intervalMs: 0,
			enabled: true,
		});
		await f.sup.tick();
		assert.deepEqual(b.lastUserSubmission, rank);
		assert.equal(
			b.events.findLast((e) => e.type === "submission-accepted")?.data.origin,
			"schedule",
		);
		await f.sup.store.moveSession({
			projectId: p.id,
			sessionId: a.id,
			targetProjectId: target.id,
		});
		assert.deepEqual(a.lastUserSubmission, before);
		assert.equal(orderedChats(target.sessions)[0].id, a.id);
		const restored = orderFixture(root, () => {});
		await restored.sup.store.init();
		assert.deepEqual(
			restored.sup.store.session(target.id, a.id).lastUserSubmission,
			before,
		);
		await assert.rejects(
			restored.sup.submit({ ...failed, projectId: target.id }),
			/Duplicate/,
		);
		assert.deepEqual(
			restored.sup.store.state.projects.map((x) => x.id),
			[p.id, target.id],
		);
	} finally {
		await f.sup.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("equal timestamps use sequence; legacy submissions never imply human origin", () => {
	const state = seedOrderFixture(),
		sessions = state.projects[0].sessions;
	sessions[0].events.push({
		type: "submission",
		at: new Date().toISOString(),
		data: { prompt: "unknown origin" },
	});
	assert.deepEqual(orderedChats(sessions), sessions);
	sessions[0].lastUserSubmission = { at: 100, sequence: 1 };
	sessions[1].lastUserSubmission = { at: 100, sequence: 2 };
	assert.equal(orderedChats(sessions)[0].id, sessions[1].id);
	assert.notEqual(orderedChats(sessions), sessions);
});

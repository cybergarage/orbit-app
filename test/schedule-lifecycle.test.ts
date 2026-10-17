import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Supervisor } from "../src/supervisor";
import type { Worker } from "../src/worker";

async function fixture(
	t: any,
	factory?: ConstructorParameters<typeof Supervisor>[2],
) {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-schedule-lifecycle-"),
	);
	const sup = new Supervisor(
		root,
		() => {},
		factory,
		async () => {
			throw new Error("No model inference in lifecycle fixtures");
		},
	);
	await sup.init();
	t.after(async () => {
		await sup.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const p = await sup.store.createProject("Synthetic schedule project");
	const s = await sup.store.createSession(p.id);
	const file = path.join(sup.store.workspace(p.id), "keep.txt");
	await fs.writeFile(file, "Retained working artifact");
	const input = {
		projectId: p.id,
		sessionId: s.id,
		prompt: "Synthetic no-effect task",
		model: "fixture",
		timing: {
			first: { kind: "relative", delayMs: 900000 },
			timeZone: "UTC",
			repeat: { kind: "interval", minutes: 15 },
		},
	};
	return { root, sup, p, s, file, input };
}
async function settled(predicate: () => boolean) {
	const deadline = Date.now() + 10000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Fixture did not settle");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("disable/edit/enable and confirmed delete persist while retaining unrelated data", async (t) => {
	const { root, sup, p, s, file, input } = await fixture(t);
	const schedule = await sup.dispatch("schedule", input);
	const other = await sup.dispatch("schedule", {
		...input,
		prompt: "Other task",
	});
	await sup.dispatch("disable-schedule", { id: schedule.id });
	await sup.dispatch("update-schedule", {
		...input,
		id: schedule.id,
		timing: undefined,
		prompt: "Edited while disabled",
	});
	assert.equal(schedule.enabled, false);
	const anchor = Date.now() - 3600000;
	schedule.nextAt = anchor;
	schedule.plan.firstAt = anchor;
	await sup.store.save();
	await sup.dispatch("enable-schedule", { id: schedule.id });
	assert.equal(schedule.enabled, true);
	assert.ok(schedule.nextAt > Date.now());
	assert.equal((schedule.nextAt - anchor) % 900000, 0);
	const resumedAt = schedule.nextAt;
	await sup.dispatch("enable-schedule", { id: schedule.id });
	assert.equal(schedule.nextAt, resumedAt);
	await sup.dispatch("disable-schedule", { id: schedule.id });
	await sup.close();
	const restored = new Supervisor(root, () => {});
	await restored.init();
	t.after(() => restored.close());
	assert.equal(
		restored.store.state.schedules.find((v) => v.id === schedule.id)?.enabled,
		false,
	);
	await assert.rejects(
		restored.dispatch("delete-schedule", { id: schedule.id }),
		/Confirm deletion/,
	);
	await assert.rejects(
		restored.dispatch("delete-schedule", {
			id: schedule.id,
			confirmation: other.id,
		}),
		/Confirm deletion/,
	);
	await restored.dispatch("delete-schedule", {
		id: schedule.id,
		confirmation: schedule.id,
	});
	assert.deepEqual(
		restored.store.state.schedules.map((v) => v.id),
		[other.id],
	);
	assert.equal(restored.store.session(p.id, s.id).id, s.id);
	assert.equal(await fs.readFile(file, "utf8"), "Retained working artifact");
	await assert.rejects(
		restored.dispatch("enable-schedule", { id: schedule.id }),
		/Schedule not found/,
	);
	await restored.close();
	const restarted = new Supervisor(root, () => {});
	await restarted.init();
	assert.deepEqual(
		restarted.store.state.schedules.map((v) => v.id),
		[other.id],
	);
	await restarted.close();
});

test("elapsed one-time tasks stay disabled until edited to a future time and explicitly enabled", async (t) => {
	const { sup, input } = await fixture(t);
	const schedule = await sup.dispatch("schedule", {
		...input,
		timing: { ...input.timing, repeat: { kind: "none" } },
	});
	await sup.dispatch("disable-schedule", { id: schedule.id });
	schedule.nextAt = Date.now() - 1;
	await assert.rejects(
		sup.dispatch("enable-schedule", { id: schedule.id }),
		/Edit its first-run time/,
	);
	assert.equal(schedule.enabled, false);
	await sup.dispatch("update-schedule", {
		...input,
		id: schedule.id,
		timing: { ...input.timing, repeat: { kind: "none" } },
	});
	assert.equal(schedule.enabled, false);
	await sup.dispatch("enable-schedule", { id: schedule.id });
	assert.equal(schedule.enabled, true);
});

for (const command of ["disable-schedule", "delete-schedule"]) {
	test(`${command} retains an admitted run, history and working files without admitting future runs`, async (t) => {
		let finish: () => void = () => {},
			emit: (event: any) => void = () => {},
			stops = 0,
			starts = 0;
		const { sup, p, s, file, input } = await fixture(
			t,
			(_workspace, _core, _config, event) => {
				emit = event;
				return {
					name: `orbit-app-${randomUUID()}`,
					start: () => {
						starts++;
						return new Promise<void>((resolve) => {
							finish = resolve;
						});
					},
					stop: async () => {
						stops++;
						finish();
					},
					confirmGone: async () => {},
				} as unknown as Worker;
			},
		);
		sup.health = async () => ({
			docker: true,
			ollama: true,
			image: true,
			models: ["fixture"],
			detail: [],
		});
		const schedule = await sup.dispatch("schedule", input);
		await sup.tick(schedule.nextAt);
		assert.equal(starts, 1);
		await sup.dispatch(command, { id: schedule.id, confirmation: schedule.id });
		assert.equal(stops, 0);
		assert.ok(sup.worker);
		emit({
			type: "result",
			data: {
				answer: "Synthetic result",
				runtime: { outcome: "completed", runId: "fixture-run" },
			},
		});
		finish();
		await settled(() => !sup.worker);
		await sup.tick(schedule.nextAt + 86400000);
		assert.equal(starts, 1);
		assert.equal(sup.store.state.executions?.length, 1);
		assert.equal(sup.store.state.executions?.[0].status, "completed");
		assert.equal(sup.store.session(p.id, s.id).answer, "Synthetic result");
		assert.equal(await fs.readFile(file, "utf8"), "Retained working artifact");
	});
}

test("a consumed one-time slot cannot be enabled again after the wall clock moves backward", async (t) => {
	const { sup, input, p, s } = await fixture(t);
	const schedule = await sup.dispatch("schedule", {
		...input,
		timing: { ...input.timing, repeat: { kind: "none" } },
	});
	await sup.dispatch("disable-schedule", { id: schedule.id });
	// The persisted admitted slot is in the future of the current wall clock.
	sup.store.state.executions = [
		{
			id: randomUUID(),
			scheduleId: schedule.id,
			projectId: p.id,
			sessionId: s.id,
			projectName: p.name,
			requestId: randomUUID(),
			dueAt: schedule.nextAt,
			startedAt: schedule.nextAt,
			endedAt: schedule.nextAt + 1,
			prompt: "Fixture",
			model: "fixture",
			status: "completed",
			events: [],
		},
	];
	await sup.store.save();
	await assert.rejects(
		sup.dispatch("enable-schedule", { id: schedule.id }),
		/already admitted/,
	);
	assert.equal(schedule.enabled, false);
});

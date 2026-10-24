import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	MemoryProjectStore,
	stableMemoryId,
	projectSourceDigest,
	type ProjectSourceCapture,
	type KnowledgeExtractor,
} from "@cybergarage/orbit";
import { Store } from "../src/store";
import { ProjectKnowledge } from "../src/project-knowledge";
import type { SourceLease } from "../src/source-leases";

function captured(
	captures: Map<string, ProjectSourceCapture>,
	id: string,
): ProjectSourceCapture {
	const source = captures.get(id);
	assert.ok(source);
	return source;
}
async function fixture(
	options: {
		change?: boolean;
		journalLost?: boolean;
		fail?: boolean;
		lost?: boolean;
		releaseFailure?: boolean;
	} = {},
) {
	const catalog = new MemoryProjectStore(),
		p = randomUUID(),
		q = randomUUID(),
		a = randomUUID(),
		b = randomUUID(),
		pairA = randomUUID(),
		pairB = randomUUID(),
		runId = randomUUID();
	for (const id of [p, q])
		await catalog.mutate(id, {
			kind: "create",
			id,
			name: "Synthetic",
			directory: null,
			expectedRevision: 0,
		});
	const store = new Store(`/tmp/orbit-knowledge-fault-${randomUUID()}`);
	store.state.projects = [
		{
			id: p,
			name: "P",
			sessions: [
				{ id: a, name: "A", status: "completed", events: [] },
				{ id: b, name: "B", status: "new", events: [], storageProjectId: q },
			],
		},
		{ id: q, name: "Q", sessions: [] },
	];
	const captures = new Map<string, ProjectSourceCapture>([
		[
			a,
			{ sessionId: a, pairId: pairA, archived: false, runs: [], messages: [] },
		],
		[
			b,
			{ sessionId: b, pairId: pairB, archived: false, runs: [], messages: [] },
		],
	]);
	let held = 0,
		calls = 0;
	const acquire = async (
		_core: string,
		ids: string[],
	): Promise<SourceLease> => {
		held++;
		let released = false;
		return {
			captures: ids.map((id) => structuredClone(captured(captures, id))),
			assertHeld() {
				if (released || options.lost) throw new Error("Synthetic helper death");
			},
			async release() {
				released = true;
				held--;
				if (options.releaseFailure)
					throw new Error("Synthetic release uncertainty");
			},
		};
	};
	const extract: KnowledgeExtractor = async (input) => {
		assert.equal(held, 0, "source locks must be released before inference");
		calls++;
		if (options.fail) throw new Error("Synthetic model unavailable");
		if (options.journalLost) captured(captures, a).runs = [];
		const message = JSON.parse(input).messages[0];
		if (options.change)
			captured(captures, a).messages[0].digest =
				projectSourceDigest("changed source");
		return {
			inputTokens: 100,
			outputTokens: 20,
			text: JSON.stringify({
				candidates: [
					{
						title: "Decision",
						body: "Use PostgreSQL.",
						kind: "decision",
						importance: 3,
						condition: "",
						messageId: message.id,
						quote: message.text,
					},
				],
			}),
		};
	};
	const knowledge = new ProjectKnowledge(store, () => true, acquire, extract);
	await knowledge.init(catalog);
	return {
		catalog,
		store,
		knowledge,
		captures,
		p,
		q,
		a,
		b,
		runId,
		options,
		held: () => held,
		calls: () => calls,
	};
}
async function admit(f: Awaited<ReturnType<typeof fixture>>) {
	const snapshot = await f.knowledge.prepare(
		f.p,
		f.a,
		randomUUID(),
		"Decide storage",
	);
	assert.ok(snapshot);
	captured(f.captures, f.a).runs.push({ runId: f.runId, snapshot });
	captured(f.captures, f.a).messages.push({
		id: randomUUID(),
		digest: projectSourceDigest("source"),
		role: "user",
		text: "Use PostgreSQL.",
		turnId: f.runId,
	});
}

test("host extraction releases locks, applies exact snapshot and excludes a moved source", async () => {
	const f = await fixture();
	try {
		await admit(f);
		f.knowledge.kick();
		await f.knowledge.settle();
		assert.equal(f.calls(), 1);
		const snapshot = await f.knowledge.prepare(
			f.p,
			f.b,
			randomUUID(),
			"PostgreSQL",
		);
		assert.equal(snapshot?.entries.length, 1);
		assert.equal(snapshot.policy, 2);
		assert.notEqual(snapshot.pairId, snapshot.entries[0].sources[0].pairId);
		f.store.state.projects[0].sessions =
			f.store.state.projects[0].sessions.filter((s) => s.id !== f.a);
		f.store.state.projects[1].sessions.push({
			id: f.a,
			name: "Moved A",
			status: "completed",
			events: [],
			storageProjectId: f.p,
		});
		await f.knowledge.synchronize(f.a);
		assert.equal(
			(await f.knowledge.prepare(f.p, f.b, randomUUID(), "PostgreSQL"))?.entries
				.length,
			0,
		);
		assert.equal(f.held(), 0);
	} finally {
		await f.knowledge.close();
	}
});
test("source changes during extraction discard candidates without holding a model lock", async () => {
	const f = await fixture({ change: true });
	try {
		await admit(f);
		f.knowledge.kick();
		await f.knowledge.settle();
		assert.equal((await f.knowledge.status(f.p)).entries.length, 0);
		f.knowledge.kick();
		await f.knowledge.settle();
		assert.equal((await f.knowledge.status(f.p)).jobs[0].state, "discarded");
		assert.equal(f.held(), 0);
	} finally {
		await f.knowledge.close();
	}
});
test("model failure preserves reservations and leaves ordinary context preparation usable", async () => {
	const f = await fixture({ fail: true });
	try {
		await admit(f);
		f.knowledge.kick();
		await f.knowledge.settle();
		const status = await f.knowledge.status(f.p);
		assert.equal(status.jobs[0].state, "failed");
		assert.equal(status.config?.inputTokens, 4096);
		assert.equal(
			(await f.knowledge.prepare(f.p, f.b, randomUUID(), "Next request"))
				?.entries.length,
			0,
		);
		await f.knowledge.configure(f.p, false);
		f.knowledge.kick();
		await f.knowledge.settle();
		assert.equal(f.calls(), 1);
	} finally {
		await f.knowledge.close();
	}
});
test("completed journal removed during inference rejects apply without consuming another call", async () => {
	const f = await fixture({ journalLost: true });
	try {
		await admit(f);
		f.knowledge.kick();
		await f.knowledge.settle();
		const status = await f.knowledge.status(f.p);
		assert.equal(status.entries.length, 0);
		assert.equal(status.jobs[0].state, "discarded");
		assert.equal(f.calls(), 1);
	} finally {
		await f.knowledge.close();
	}
});

test("helper loss and uncertain release prevent snapshot capture and later admission", async () => {
	const f = await fixture({ lost: true, releaseFailure: true });
	await assert.rejects(
		f.knowledge.prepare(f.p, f.a, randomUUID(), "Request"),
		/ownership cleanup/,
	);
	assert.equal(f.calls(), 0);
	assert.equal(f.held(), 0);
	await assert.rejects(
		f.knowledge.prepare(f.p, f.b, randomUUID(), "Next"),
		/ownership cleanup/,
	);
	await assert.rejects(f.knowledge.close(), /ownership cleanup/);
});

test("archived sources and Projects stop new reuse while preserving existing snapshots and data", async () => {
	const f = await fixture();
	try {
		await admit(f);
		f.knowledge.kick();
		await f.knowledge.settle();
		const frozen = await f.knowledge.prepare(
			f.p,
			f.b,
			randomUUID(),
			"PostgreSQL",
		);
		assert.ok(frozen);
		assert.equal(frozen.entries.length, 1);
		const source = f.captures.get(f.a);
		assert.ok(source);
		source.archived = true;
		assert.equal(
			(await f.knowledge.prepare(f.p, f.b, randomUUID(), "PostgreSQL"))?.entries
				.length,
			0,
		);
		assert.equal(frozen.entries.length, 1);
		source.archived = false;
		assert.equal(
			(await f.knowledge.prepare(f.p, f.b, randomUUID(), "PostgreSQL"))?.entries
				.length,
			1,
		);
		const project = await f.catalog.query({ kind: "project", id: f.p });
		assert.ok(project);
		await f.catalog.mutate(randomUUID(), {
			kind: "update",
			id: f.p,
			expectedRevision: project.revision,
			archived: true,
		});
		f.store.project(f.p).archived = true;
		await assert.rejects(
			f.knowledge.prepare(f.p, f.b, randomUUID(), "PostgreSQL"),
		);
		assert.equal((await f.knowledge.status(f.p)).entries.length, 1);
	} finally {
		await f.knowledge.close();
	}
});

async function automatically(read: () => Promise<boolean>) {
	const end = Date.now() + 20000;
	while (!(await read())) {
		if (Date.now() > end)
			throw new Error("Automatic wakeup did not drain persisted work");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
test("production wakeup drains more than four startup jobs without an explicit kick", {
	timeout: 25000,
}, async () => {
	const f = await fixture();
	try {
		for (let index = 0; index < 6; index++) {
			f.runId = randomUUID();
			await admit(f);
		}
		const capture = captured(f.captures, f.a);
		for (const run of capture.runs) {
			const messages = capture.messages
				.filter((message) => message.turnId === run.runId)
				.map((message) => ({
					id: message.id,
					digest: message.digest,
					role: message.role,
					text: message.text ?? "",
				}));
			const id = stableMemoryId([capture.pairId, f.a, run.runId, "extract-v1"]);
			await f.catalog.mutate(id, {
				kind: "extraction",
				expectedRevision: 0,
				generation: 0,
				entries: [],
				job: {
					id,
					admissionDigest: run.snapshot.digest,
					projectId: f.p,
					pairId: capture.pairId,
					sessionId: f.a,
					runId: run.runId,
					membershipRevision: run.snapshot.membershipRevision,
					messages,
					sourceDigest: projectSourceDigest(messages),
					state: "pending",
					attempt: 0,
					revision: 0,
					inputTokens: 0,
					outputTokens: 0,
				},
			});
		}
		assert.equal((await f.knowledge.status(f.p)).jobs.length, 6);
		await automatically(
			async () =>
				(await f.knowledge.status(f.p)).jobs.filter(
					(job) => job.state === "completed",
				).length === 6,
		);
		assert.equal(f.calls(), 6);
	} finally {
		await f.knowledge.close();
	}
});
test("production wakeup retries transient failure, and resume or budget changes wake work automatically", {
	timeout: 25000,
}, async () => {
	const f = await fixture({ fail: true });
	try {
		await admit(f);
		await automatically(async () => f.calls() === 1);
		f.options.fail = false;
		await automatically(
			async () =>
				(await f.knowledge.status(f.p)).jobs[0]?.state === "completed",
		);
		assert.equal(f.calls(), 2);
		await f.knowledge.configure(f.p, false);
		f.runId = randomUUID();
		await admit(f);
		await f.knowledge.configure(f.p, true);
		await automatically(async () => f.calls() === 3);
		await f.knowledge.configure(f.p, true, {
			maxCalls: 3,
			maxInputTokens: 12288,
			maxOutputTokens: 3072,
		});
		f.runId = randomUUID();
		await admit(f);
		await f.knowledge.configure(f.p, true, {
			maxCalls: 4,
			maxInputTokens: 16384,
			maxOutputTokens: 4096,
		});
		await automatically(async () => f.calls() === 4);
	} finally {
		await f.knowledge.close();
	}
});

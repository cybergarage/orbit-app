import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AutoTitles,
	provisionalTitle,
	generateTitle,
} from "../src/auto-titles";
import { Store } from "../src/store";
async function fixture(
	generate: (
		prompt: string,
		model: string,
		signal: AbortSignal,
	) => Promise<string>,
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-title-unit-"));
	const records = new Map<string, { name: string; revision: number }>();
	const names = {
		async call(_core: string, p: Record<string, unknown>) {
			const id = String(p.sessionId ?? p.projectId);
			if (p.command === "create-session") {
				records.set(id, { name: "", revision: 0 });
				return { revision: 0 };
			}
			if (p.command === "create-project") {
				const value = { name: String(p.name), revision: 0 };
				records.set(id, value);
				return value;
			}
			if (p.command === "rename-session") {
				const prior = records.get(id);
				if (!prior || prior.revision !== p.expectedRevision)
					throw Error("revision conflict");
				const value = { name: String(p.name), revision: prior.revision + 1 };
				records.set(id, value);
				return value;
			}
			throw Error("Unexpected operation");
		},
	};
	const store = new Store(root, names);
	await store.init();
	const project = await store.createProject("Fixture"),
		session = await store.createSession(project.id);
	let idle = true;
	const titles = new AutoTitles(
		store,
		() => idle,
		() => store.save(),
		generate,
	);
	const stop = async () => {
		await titles.close();
		await fs.rm(root, { recursive: true, force: true });
	};
	return {
		store,
		project,
		session,
		titles,
		records,
		names,
		stop,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}
async function until(condition: () => boolean) {
	const end = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > end) throw Error("Timed out");
		await new Promise((r) => setTimeout(r, 2));
	}
}
test("provisional title is bounded and core rename persists generated title without transcript events", async () => {
	const f = await fixture(async (prompt, model) => {
		assert.equal(prompt, "Plan a Kyoto weekend");
		assert.equal(model, "selected-local-model");
		return "Kyoto weekend";
	});
	try {
		await f.titles.provision(
			f.project.id,
			f.session,
			"Plan a Kyoto weekend",
			"selected-local-model",
		);
		assert.equal(f.session.name, "Plan a Kyoto weekend");
		f.titles.kick();
		await until(() => f.session.autoTitle?.stage === "done");
		assert.equal(f.records.get(f.session.id)?.name, "Kyoto weekend");
		assert.deepEqual(f.session.events, []);
		assert.equal(provisionalTitle("  a\n b  "), "a b");
	} finally {
		await f.stop();
	}
});
test("manual rename invalidates an in-flight generation and cannot be overwritten", async () => {
	let finish: (title: string) => void = () => {};
	let started = false;
	const f = await fixture(
		() =>
			new Promise((resolve) => {
				finish = resolve;
				started = true;
			}),
	);
	try {
		await f.titles.provision(f.project.id, f.session, "First input", "local");
		f.titles.kick();
		await until(() => started);
		const interrupted = f.titles.interrupt(f.session.id);
		finish("Late auto title");
		await interrupted;
		await f.store.renameSession({
			projectId: f.project.id,
			sessionId: f.session.id,
			name: "My manual title",
			expectedRevision: f.session.nameRevision,
		});
		assert.equal(f.session.name, "My manual title");
		assert.equal(f.session.autoTitle?.stage, "manual");
	} finally {
		await f.stop();
	}
});
test("external revision conflict discards generated name; failure and interruption keep provisional", async () => {
	let calls = 0;
	const f = await fixture(async () => {
		calls++;
		f.records.set(f.session.id, { name: "External rename", revision: 99 });
		return "Must not apply";
	});
	try {
		await f.titles.provision(f.project.id, f.session, "Provisional", "local");
		f.titles.kick();
		await until(() => f.session.autoTitle?.stage === "failed");
		assert.equal(f.records.get(f.session.id)?.name, "External rename");
		f.titles.kick();
		assert.equal(calls, 1);
	} finally {
		await f.stop();
	}
	const g = await fixture(async () => {
		throw Error("model unavailable");
	});
	try {
		await g.titles.provision(g.project.id, g.session, "Keep this", "local");
		g.setIdle(false);
		g.titles.kick();
		assert.equal(g.session.autoTitle?.stage, "pending");
		g.setIdle(true);
		g.titles.kick();
		await until(() => g.session.autoTitle?.stage === "failed");
		assert.equal(g.session.name, "Keep this");
	} finally {
		await g.stop();
	}
});
test("new work aborts background generation and shutdown never retries it", async () => {
	let started = false;
	const f = await fixture(
		(_p, _m, signal) =>
			new Promise((_resolve, reject) => {
				started = true;
				signal.addEventListener("abort", () => reject(Error("aborted")), {
					once: true,
				});
			}),
	);
	try {
		await f.titles.provision(f.project.id, f.session, "Keep snippet", "local");
		f.titles.kick();
		await until(() => started);
		f.setIdle(false);
		await f.titles.interrupt();
		assert.equal(f.session.name, "Keep snippet");
		assert.equal(f.session.autoTitle?.stage, "failed");
	} finally {
		await f.stop();
	}
});

test("title model request has only first input, fixed local model, no tools and a short bound", async () => {
	const original = globalThis.fetch;
	let payload: any;
	globalThis.fetch = async (input, options) => {
		assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
		payload = JSON.parse(String(options?.body));
		return new Response(
			JSON.stringify({ message: { content: "A short title" } }),
			{ status: 200 },
		);
	};
	try {
		assert.equal(
			await generateTitle(
				"x".repeat(1200),
				"selected",
				new AbortController().signal,
			),
			"A short title",
		);
		assert.equal(payload.model, "selected");
		assert.equal(payload.messages.length, 2);
		assert.equal(payload.messages[1].content.length, 1000);
		assert.equal(payload.tools, undefined);
		assert.equal(payload.options.num_predict, 64);
		assert.equal(payload.stream, false);
		assert.equal(payload.think, false);
	} finally {
		globalThis.fetch = original;
	}
});

test("manual rename during provisional persistence keeps the job invalidated", async () => {
	const f = await fixture(async () => "Must not generate");
	let release: () => void = () => {};
	let started = false;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const call = f.names.call.bind(f.names);
	f.names.call = async (core, request) => {
		if (
			request.command === "rename-session" &&
			request.name === "First input"
		) {
			started = true;
			await gate;
		}
		return call(core, request);
	};
	try {
		const pending = f.titles.provision(
			f.project.id,
			f.session,
			"First input",
			"local",
		);
		await until(() => started);
		await f.titles.interrupt(f.session.id);
		release();
		await pending;
		await f.store.renameSession({
			projectId: f.project.id,
			sessionId: f.session.id,
			name: "Manual",
			expectedRevision: f.session.nameRevision,
		});
		f.titles.kick();
		assert.equal(f.session.autoTitle?.stage, "manual");
		assert.equal(f.session.name, "Manual");
	} finally {
		release();
		await f.stop();
	}
});

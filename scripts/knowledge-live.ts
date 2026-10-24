/** Opt-in synthetic local-model quality trial; never part of deterministic tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Supervisor } from "../src/supervisor";
import { extractLocalKnowledge } from "../src/project-knowledge";
import { acquireContainerSources } from "../src/source-leases";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-knowledge-live-"));
const originalFetch = globalThis.fetch;
let ordinaryCalls = 0,
	extractionCalls = 0;
const model = "gemma4:12b";
globalThis.fetch = async (url, options) => {
	if (String(url).endsWith("/api/chat")) {
		ordinaryCalls++;
		if (ordinaryCalls > 2)
			throw new Error("Synthetic ordinary model call cap reached");
		const request = JSON.parse(String(options?.body));
		if (request.model !== model) throw new Error("Unexpected live model");
		request.options = { ...request.options, num_predict: 128 };
		request.think = false;
		options = { ...options, body: JSON.stringify(request) };
	}
	return originalFetch(url, options);
};
const sup = new Supervisor(
	root,
	() => {},
	undefined,
	async () => {
		throw new Error("No title inference in quality trial");
	},
	{
		extract: async (input, signal) => {
			extractionCalls++;
			if (extractionCalls > 1)
				throw new Error("Synthetic extractor call cap reached");
			return extractLocalKnowledge(input, signal);
		},
	},
);
async function until<T>(
	read: () => Promise<T>,
	ready: (value: T) => boolean,
	ms = 150000,
) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const result = await read();
		if (ready(result)) return result;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Synthetic quality trial deadline reached");
}
try {
	await sup.init();
	const p = await sup.store.createProject("Synthetic local knowledge quality");
	const a = await sup.store.createSession(p.id);
	await sup.knowledge.configure(p.id, true, {
		maxCalls: 1,
		maxInputTokens: 4096,
		maxOutputTokens: 1024,
	});
	await sup.submit({
		projectId: p.id,
		sessionId: a.id,
		model,
		requestId: randomUUID(),
		prompt:
			"Synthetic Project decision: use PostgreSQL for the catalog database. Constraint: do not add a network database dependency for tests; use fixtures. Redis is only an unverified idea, not a decision. Do not use tools. Reply only Acknowledged.",
	});
	await until(
		async () => sup.store.session(p.id, a.id).status,
		(status) => ["completed", "failed", "incomplete"].includes(status),
	);
	await until(
		() => sup.knowledge.status(p.id),
		(status) =>
			status.jobs.some((job) =>
				["completed", "failed", "discarded"].includes(job.state),
			),
	);
	await sup.knowledge.interrupt();
	const knowledge = await sup.knowledge.status(p.id);
	const b = await sup.store.createSession(p.id);
	await sup.submit({
		projectId: p.id,
		sessionId: b.id,
		model,
		requestId: randomUUID(),
		prompt:
			"Which database was decided for the catalog, and what constraint applies to database dependencies in tests? Answer from Project context. Do not use tools; do not invent a choice if no decision is available.",
	});
	await until(
		async () => sup.store.session(p.id, b.id).status,
		(status) => ["completed", "failed", "incomplete"].includes(status),
	);
	await sup.knowledge.interrupt();
	const lease = await acquireContainerSources(
		sup.store.location(p.id, b.id).core,
		[b.id],
	);
	let snapshot: import("@cybergarage/orbit").ProjectContextSnapshot | undefined;
	try {
		snapshot = lease.captures[0].runs.at(-1)?.snapshot;
	} finally {
		await lease.release();
	}
	const answer = sup.store.session(p.id, b.id).answer;
	console.log(
		JSON.stringify(
			{
				model,
				ordinaryCalls,
				extractionCalls,
				path: "Supervisor -> disposable Agent worker A -> completed journal -> host local tool-free extractor -> catalog -> frozen Project snapshot -> disposable Agent worker B",
				aStatus: sup.store.session(p.id, a.id).status,
				bStatus: sup.store.session(p.id, b.id).status,
				entries: knowledge.entries.map(({ body, automatic }) => ({
					body,
					automatic,
				})),
				jobs: knowledge.jobs.map(({ state, error, attempt }) => ({
					state,
					error,
					attempt,
				})),
				usage: knowledge.config,
				snapshotEntries: snapshot?.entries.map(({ id, revision, body }) => ({
					id,
					revision,
					body,
				})),
				answer,
				passed:
					!!snapshot?.entries.length &&
					/postgresql/i.test(answer ?? "") &&
					!knowledge.entries.some((entry) => /redis/i.test(entry.body)),
				limits:
					"One synthetic case; no correction or broad factual-quality claim; ordinary answers capped at 128 requested output tokens, extractor one call with 4096/1024 reservation; no paid provider or downloads.",
			},
			null,
			2,
		),
	);
} finally {
	await sup.close();
	globalThis.fetch = originalFetch;
	await fs.rm(root, { recursive: true, force: true });
}

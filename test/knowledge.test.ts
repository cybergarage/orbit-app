import { localFixtureModels } from "./fixtures/local-models";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContainerCoreNames } from "../src/core-names";
import { Supervisor } from "../src/supervisor";
import { command, dockerPath } from "../src/worker";
import { acquireContainerSources } from "../src/source-leases";

async function until<T>(
	read: () => Promise<T>,
	accepts: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + 90000;
	while (true) {
		const value = await read();
		if (accepts(value)) return value;
		if (Date.now() > deadline) throw new Error("Knowledge fixture timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

test("real Supervisor, source helpers and disposable workers automatically reuse A in moved B across restart", {
	timeout: 240000,
}, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-knowledge-e2e-"));
	const originalFetch = globalThis.fetch;
	let extractions = 0;
	const seen: string[] = [];
	const extractionInputs: string[] = [];
	globalThis.fetch = async (url, options) => {
		const route = String(url).split("/").at(-1);
		const request = options?.body ? JSON.parse(String(options.body)) : {};
		if (route === "ps") return Response.json({ models: [] });
		if (route === "show")
			return Response.json({
				model_info: { "gemma4.context_length": 8192 },
				capabilities: ["completion", "tools"],
			});
		assert.equal(route, "chat");
		const input = JSON.stringify(request.messages);
		seen.push(input);
		const last = request.messages.at(-1)?.content ?? "";
		return Response.json({
			model: "gemma4:12b",
			done: true,
			done_reason: "stop",
			created_at: new Date().toISOString(),
			eval_duration: 1,
			prompt_eval_duration: 1,
			load_duration: 1,
			total_duration: 2,
			prompt_eval_count: 120,
			eval_count: 10,
			message: {
				role: "assistant",
				content: last.includes("Which database")
					? input.includes("Untrusted Project memory") &&
						input.includes("Use PostgreSQL")
						? "PostgreSQL selected"
						: "NO_MEMORY"
					: "Acknowledged",
			},
		});
	};
	const extract = async (input: string) => {
		extractions++;
		extractionInputs.push(input);
		const source = JSON.parse(input).messages.find(
			(message: any) =>
				message.role === "user" && message.text.startsWith("Use PostgreSQL"),
		);
		return {
			inputTokens: 200,
			outputTokens: 30,
			text: JSON.stringify({
				candidates: source
					? [
							{
								title: "Database",
								body: "Use PostgreSQL for the catalog.",
								condition: "Catalog",
								importance: 3,
								kind: "decision",
								messageId: source.id,
								quote: source.text,
							},
						]
					: [],
			}),
		};
	};
	const create = () =>
		new Supervisor(
			root,
			() => {},
			undefined,
			async () => {
				throw new Error("No title inference");
			},
			{ extract },
			localFixtureModels(),
		);
	let stage = "initialize";
	let sup = create();
	sup.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["gemma4:12b"],
		detail: [],
	});
	try {
		await sup.init();
		const project = await sup.store.createProject(
			"Synthetic knowledge project",
		);
		const source = await sup.store.createSession(project.id);
		await sup.submit({
			projectId: project.id,
			sessionId: source.id,
			prompt: "Use PostgreSQL for the catalog.",
			model: "gemma4:12b",
			requestId: randomUUID(),
		});
		await until(
			async () => sup.store.session(project.id, source.id).status,
			(status) => ["completed", "failed", "incomplete"].includes(status),
		);
		assert.equal(
			sup.store.session(project.id, source.id).status,
			"completed",
			JSON.stringify(sup.store.session(project.id, source.id).events),
		);
		const learned: any = await until(
			() => sup.knowledge.status(project.id),
			(status) => status.jobs.some((job) => job.state === "completed"),
		);
		assert.equal(
			learned.entries.length,
			1,
			JSON.stringify({ learned, extractionInputs }),
		);
		assert.equal(learned.config.inputTokens, 4096);
		assert.equal(learned.config.calls, 1);
		assert.equal(learned.config.observedInputTokens, 200);
		await sup.close();
		sup = create();
		sup.health = async () => ({
			docker: true,
			ollama: true,
			image: true,
			models: ["gemma4:12b"],
			detail: [],
		});
		await sup.init();
		const other = await sup.store.createProject("Original storage project");
		const target = await sup.store.createSession(other.id);
		await sup.dispatch("move-session", {
			projectId: other.id,
			sessionId: target.id,
			targetProjectId: project.id,
		});
		assert.equal(
			sup.store.session(project.id, target.id).storageProjectId,
			other.id,
		);
		stage = "fill persistent queue before ordinary worker admission";
		await sup.knowledge.interrupt();
		const metadata = new ContainerCoreNames(root);
		try {
			for (let index = 0; index < 32; index++) {
				const job = {
					...learned.jobs[0],
					id: randomUUID(),
					runId: randomUUID(),
					state: "pending",
					attempt: 0,
					revision: 0,
					inputTokens: 0,
					outputTokens: 0,
					observedInputTokens: 0,
					observedOutputTokens: 0,
				};
				await metadata.call(path.join(root, "catalog"), {
					command: "catalog-mutate",
					operationId: randomUUID(),
					mutation: {
						kind: "extraction",
						expectedRevision: 0,
						generation: 0,
						entries: [],
						job,
					},
				});
			}
			assert.equal((await sup.knowledge.status(project.id)).queue.pending, 32);
		} finally {
			await metadata.close();
		}
		stage = "ordinary worker answer with full persistent queue";
		await sup.submit({
			projectId: project.id,
			sessionId: target.id,
			prompt: "Which database stores the catalog?",
			model: "gemma4:12b",
			requestId: randomUUID(),
		});
		await until(
			async () => sup.store.session(project.id, target.id).status,
			(status) => ["completed", "failed"].includes(status),
		);
		assert.equal(
			sup.store.session(project.id, target.id).answer,
			"PostgreSQL selected",
		);
		assert.ok(seen.some((input) => input.includes("Untrusted Project memory")));
		await sup.knowledge.interrupt();
		const lease = await acquireContainerSources(
			sup.store.location(project.id, target.id).core,
			[target.id],
		);
		try {
			const captured = lease.captures[0].runs.at(-1)?.snapshot;
			assert.ok(captured);
			assert.equal(captured.policy, 2);
			assert.equal(captured.entries[0].revision, 1);
			assert.notEqual(captured.entries[0].sources[0].pairId, captured.pairId);
		} finally {
			await lease.release();
		}
		await sup.dispatch("knowledge-control", {
			projectId: project.id,
			enabled: false,
		});
		await sup.dispatch("knowledge-edit", {
			projectId: project.id,
			id: learned.entries[0].id,
			expectedRevision: 1,
			body: learned.entries[0].body,
			retired: true,
		});
		await sup.dispatch("knowledge-control", {
			projectId: project.id,
			enabled: true,
		});
		sup.knowledge.kick();
		await sup.knowledge.interrupt();
		const status: any = await sup.knowledge.status(project.id);
		assert.equal(status.entries[0].retired, true);
		assert.ok(extractions <= 3);
		await sup.knowledge.interrupt();
		const core = sup.store.location(project.id, source.id).core;
		stage = "archive source";
		await sup.dispatch("archive-session", {
			projectId: project.id,
			sessionId: source.id,
			archived: true,
		});
		assert.equal(sup.store.session(project.id, source.id).archived, true);
		const archived = await acquireContainerSources(core, [source.id]);
		try {
			assert.equal(archived.captures[0].archived, true);
		} finally {
			await archived.release();
		}
		await sup.dispatch("archive-session", {
			projectId: project.id,
			sessionId: source.id,
			archived: false,
		});
		stage = "archive project";
		await sup.dispatch("archive-project", {
			projectId: project.id,
			archived: true,
		});
		await assert.rejects(
			sup.submit({
				projectId: project.id,
				sessionId: target.id,
				prompt: "Synthetic archived request",
				model: "gemma4:12b",
				requestId: randomUUID(),
			}),
			/archived/i,
		);
		await sup.dispatch("archive-project", {
			projectId: project.id,
			archived: false,
		});
		assert.equal(sup.store.project(project.id).archived, false);
		stage = "acquire before kill";
		const lost = await acquireContainerSources(core, [source.id]);
		const helperName = lost.containerName;
		assert.ok(helperName);
		assert.ok(helperName.startsWith("orbit-app-source-"));
		stage = "kill helper";
		await command(dockerPath, ["kill", "--signal", "KILL", helperName]);
		await until(async () => {
			try {
				lost.assertHeld();
				return false;
			} catch {
				return true;
			}
		}, Boolean);
		stage = "release killed helper";
		await assert.rejects(lost.release());
		stage = "reacquire after kill";
		const recovered = await acquireContainerSources(core, [source.id]);
		try {
			assert.equal(recovered.captures[0].sessionId, source.id);
		} finally {
			await recovered.release();
		}
	} catch (error) {
		throw new Error(`Knowledge fault stage: ${stage}`, { cause: error });
	} finally {
		await sup.close();
		globalThis.fetch = originalFetch;
		await fs.rm(root, { recursive: true, force: true });
	}
});

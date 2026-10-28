import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "../src/worker";
import { CoreModelsHost } from "../src/core-models";

test("bundled Core host catalog filters missing credentials and local capabilities", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-catalog-"));
	const originalFetch = globalThis.fetch;
	await fs.mkdir(path.join(root, ".orbit"));
	await fs.writeFile(
		path.join(root, ".orbit/settings.json"),
		JSON.stringify({
			providers: {
				openai: { apiKeyEnv: "ORBIT_FIXTURE_ABSENT_OPENAI" },
				anthropic: { apiKeyEnv: "ORBIT_FIXTURE_ABSENT_CLAUDE" },
			},
		}),
	);
	globalThis.fetch = async (url, options) => {
		if (String(url).endsWith("/tags"))
			return Response.json({
				models: [{ name: "tools" }, { name: "text-only" }],
			});
		assert.ok(
			String(url).endsWith("/show"),
			"Remote listing must not run without keys",
		);
		return Response.json({
			capabilities:
				JSON.parse(String(options?.body)).model === "tools"
					? ["tools"]
					: ["completion"],
		});
	};
	try {
		const catalog = await new CoreModelsHost().catalog(root, true);
		assert.deepEqual(
			catalog.providers
				.find((p) => p.provider === "ollama")
				?.models.map((m) => m.model),
			["tools"],
		);
		assert.ok(
			catalog.providers
				.filter((p) => p.provider !== "ollama")
				.every((p) => p.status === "unconfigured" && p.models.length === 0),
		);
	} finally {
		globalThis.fetch = originalFetch;
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("offline disposable workers use bundled adapters and preserve history across provider changes", {
	timeout: 90000,
}, async () => {
	const { ModelGateway, SessionRepository } = await import(
		"@cybergarage/orbit"
	);
	type Options = ConstructorParameters<typeof ModelGateway>[2];
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-provider-worker-"),
	);
	const workspace = path.join(root, "workspace"),
		core = path.join(root, "core");
	await fs.mkdir(workspace, { mode: 0o700 });
	await fs.mkdir(core, { mode: 0o700 });
	const sessionId = randomUUID();
	const routes: string[] = [];
	const inputs: string[] = [];
	const settings = {
		providers: {
			openai: { apiKey: "fake-worker-openai" },
			anthropic: { apiKey: "fake-worker-claude" },
		},
	};
	const options: Options = {
		openai: {
			chat: {
				completions: {
					create: async (body: unknown) => {
						inputs.push(JSON.stringify(body));
						return {
							id: "mock",
							model: "gpt-4o",
							choices: [
								{
									finish_reason: "stop",
									message: {
										role: "assistant",
										content: "OpenAI mocked",
										refusal: null,
									},
								},
							],
							usage: {
								prompt_tokens: 5,
								completion_tokens: 2,
								total_tokens: 7,
							},
						};
					},
				},
			},
		} as unknown as NonNullable<Options>["openai"],
		anthropic: {
			models: {
				retrieve: async () => ({ max_input_tokens: 100000, max_tokens: 4096 }),
			},
			messages: {
				create: async (body: unknown) => {
					inputs.push(JSON.stringify(body));
					return {
						id: "mock",
						model: "claude-fixture",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "Claude mocked" }],
						usage: {
							input_tokens: 5,
							output_tokens: 2,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					};
				},
			},
		} as unknown as NonNullable<Options>["anthropic"],
		fetcher: async (url, request) => {
			if (String(url).endsWith("/show"))
				return Response.json({
					model_info: { "fixture.context_length": 8192 },
					capabilities: ["tools", "completion"],
				});
			if (String(url).endsWith("/ps")) return Response.json({ models: [] });
			assert.ok(String(url).endsWith("/chat"));
			inputs.push(String(request?.body));
			return Response.json({
				model: "local-fixture",
				created_at: new Date().toISOString(),
				eval_duration: 1,
				load_duration: 1,
				prompt_eval_duration: 1,
				total_duration: 2,
				done: true,
				done_reason: "stop",
				message: { role: "assistant", content: "Ollama mocked" },
				prompt_eval_count: 5,
				eval_count: 2,
			});
		},
	};
	let worker: Worker | undefined;
	try {
		for (const [provider, model, answer, expectedRoute] of [
			["openai", "gpt-4o", "OpenAI mocked", "openai-chat"],
			["anthropic", "claude-fixture", "Claude mocked", "anthropic-messages"],
			["ollama", "local-fixture", "Ollama mocked", "chat"],
		]) {
			const events: any[] = [];
			const gateway = new ModelGateway(settings, { provider, model }, options);
			worker = new Worker(
				workspace,
				core,
				{
					sessionId,
					requestId: randomUUID(),
					provider,
					model,
					prompt: `Synthetic ${provider} turn`,
				},
				(event) => events.push(event),
				{
					request: async (route, body, signal) => {
						routes.push(route);
						return gateway.request(route, body, signal);
					},
				},
			);
			await worker.start();
			await worker.confirmGone();
			const result = events.find((event) => event.type === "result")?.data;
			assert.equal(
				result?.runtime.outcome,
				"completed",
				JSON.stringify(events),
			);
			assert.equal(result.answer, answer);
			assert.ok(routes.includes(expectedRoute));
			assert.equal(JSON.stringify(events).includes("fake-worker-"), false);
			const saved = await new SessionRepository({
				rootDir: path.join(core, "sessions"),
			}).findById(sessionId);
			assert.equal(saved?.provider, provider);
			assert.equal(saved?.model, model);
		}
		assert.ok(
			inputs[1].includes("OpenAI mocked"),
			"Claude must receive restored OpenAI history",
		);
		assert.ok(
			inputs[2].includes("Claude mocked"),
			"Ollama must receive restored Claude history",
		);
	} finally {
		await worker?.stop();
		await worker?.confirmGone();
		await fs.rm(root, { recursive: true, force: true });
	}
});

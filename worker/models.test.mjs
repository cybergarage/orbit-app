import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerModel } from "./models.mjs";
import { Message, MessageType } from "@cybergarage/orbit";
const input = [
	new Message(MessageType.User, { content: "Synthetic routing input" }),
];
test("worker uses the actual OpenAI adapter and only the OpenAI host route", async () => {
	const calls = [];
	const model = createWorkerModel(
		{ provider: "openai", model: "gpt-4o" },
		async (route, body) => {
			calls.push({ route, body });
			return {
				id: "mock",
				model: "gpt-4o",
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: "openai mocked",
							refusal: null,
						},
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			};
		},
	);
	assert.equal(model.getProvider(), "openai");
	assert.equal((await model.invoke(input)).content, "openai mocked");
	assert.equal(calls[0].route, "openai-chat");
	assert.equal(calls[0].body.model, "gpt-4o");
	assert.equal(JSON.stringify(calls).includes("apiKey"), false);
});
test("worker uses the actual Claude adapter and isolated metadata/messages routes", async () => {
	const calls = [];
	const model = createWorkerModel(
		{ provider: "anthropic", model: "claude-mock" },
		async (route, body) => {
			calls.push({ route, body });
			return route === "anthropic-model"
				? { max_input_tokens: 100000, max_tokens: 4096 }
				: {
						id: "mock",
						model: "claude-mock",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "claude mocked" }],
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					};
		},
	);
	assert.equal(model.getProvider(), "anthropic");
	await model.getContextInfo();
	assert.equal((await model.invoke(input)).content, "claude mocked");
	assert.deepEqual(
		calls.map((call) => call.route),
		["anthropic-model", "anthropic-messages"],
	);
	assert.equal(calls[1].body.model, "claude-mock");
});
test("legacy worker configuration stays Ollama and unsupported providers are refused", async () => {
	let route;
	const model = createWorkerModel({ model: "local" }, async (value) => {
		route = value;
		return {
			model: "local",
			done: true,
			done_reason: "stop",
			message: { role: "assistant", content: "local mocked" },
		};
	});
	assert.equal(model.getProvider(), "ollama");
	assert.equal((await model.invoke(input)).content, "local mocked");
	assert.equal(route, "chat");
	assert.throws(
		() => createWorkerModel({ provider: "apple", model: "system" }, () => {}),
		/Unsupported coding provider/,
	);
});

import { OllamaAgent } from "@cybergarage/orbit/dist/core/models/adapters/ollama.js";
import { OpenAIAgent } from "@cybergarage/orbit/dist/core/models/adapters/openai.js";
import { AnthropicAgent } from "@cybergarage/orbit/dist/core/models/adapters/anthropic.js";
/** Inject transport only; request/response adaptation remains in the real Core adapters. */
export function createWorkerModel(config, rpc) {
	const provider = config.provider ?? "ollama";
	const connection = {
		getName: () => provider,
		getContextWindow: () => (provider === "ollama" ? 8192 : undefined),
	};
	if (provider === "openai")
		return new OpenAIAgent(config.model, connection, {
			client: {
				chat: {
					completions: { create: (request) => rpc("openai-chat", request) },
				},
			},
		});
	if (provider === "anthropic")
		return new AnthropicAgent(config.model, connection, {
			client: {
				messages: { create: (request) => rpc("anthropic-messages", request) },
				models: { retrieve: () => rpc("anthropic-model") },
			},
		});
	if (provider !== "ollama") throw new Error("Unsupported coding provider");
	return new OllamaAgent(config.model, connection, {
		client: {
			chat: (request) => rpc("chat", request),
			ps: () => rpc("ps"),
			show: (request) => rpc("show", request),
			abort: () => {},
		},
	});
}

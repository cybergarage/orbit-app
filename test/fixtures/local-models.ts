import type { ModelsHost } from "../../src/core-models";
import { modelRequest } from "../../src/worker";

/** Shared deterministic transport for the knowledge unit and Electron fixtures. */
export function localFixtureModels(): ModelsHost {
	return {
		catalog: () =>
			Promise.resolve({
				checkedAt: Date.now(),
				expiresAt: Date.now() + 30000,
				providers: [
					{
						provider: "ollama",
						label: "Ollama",
						status: "available",
						credential: "not-required",
						models: [
							{
								provider: "ollama",
								model: "gemma4:12b",
								label: "gemma4:12b",
								tools: true,
							},
						],
					},
				],
			}),
		request: (_cwd, selection, route, body, signal) =>
			modelRequest(route, body, selection.model, signal),
	};
}

import type { Model } from "@cybergarage/orbit";
export function createWorkerModel(
	config: { model: string; provider?: string },
	rpc: (route: string, body?: unknown) => Promise<unknown>,
): Model;

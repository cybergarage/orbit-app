import fs from "node:fs";
import { createInterface } from "node:readline";
import { assertStorageResetOffline } from "@cybergarage/orbit/dist/core/session/coordination.js";
import {
	planInitialization,
	executeInitialization,
	SessionRepository,
} from "@cybergarage/orbit";

// Only the registered Worker namespace is accepted. No profile or paths come from IPC.
export function maintenance(request) {
	const profile = {
		ownedRoots: ["/state"],
		preservedPaths: [],
		cacheRoots: [],
		settingsFiles: [],
		scheduledRoots: [],
		stores: [
			{
				sessionRoot: "/state/sessions",
				journalRoot: "/state/runs",
				logRoot: "/state/logs",
				projectFile: "/state/projects.sqlite",
			},
		],
	};
	const plan = planInitialization(profile, "data");
	if (request.action === "plan") return plan;
	const repository = new SessionRepository({
		rootDir: "/state/sessions",
		journalRoot: "/state/runs",
	});
	const registration = repository.inspectStorage();
	if (!["ready", "unregistered"].includes(registration.state))
		throw new Error(
			"Registration ownership is uncertain; retain evidence and inspect offline",
		);
	try {
		// Persisted title receipts are data, not writer ownership. Every other
		// coordination artifact (including guards/owners) needs offline review.
		if (
			fs
				.readdirSync("/state/sessions/.coordination")
				.some((name) => !/^[a-f0-9-]{36}\.title\.json$/.test(name))
		)
			throw new Error(
				"Writer coordination evidence remains; retain it and inspect offline",
			);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	assertStorageResetOffline("/state/sessions", "/state/runs", request.consent);
	if (request.action === "verify") return plan;
	if (request.action !== "execute" || request.planId !== plan.id)
		throw new Error("Storage plan changed; review again before initialization");
	return executeInitialization(plan, request.consent);
}
if (process.argv[1]?.endsWith("/maintenance.mjs")) {
	const lines = createInterface({ input: process.stdin });
	const { value, done } = await lines[Symbol.asyncIterator]().next();
	try {
		if (done) throw new Error("Missing maintenance request");
		console.log(JSON.stringify({ result: maintenance(JSON.parse(value)) }));
	} catch (error) {
		console.log(
			JSON.stringify({
				error:
					error instanceof SyntaxError
						? "Invalid coordination JSON retained; inspect offline"
						: String(error),
			}),
		);
		process.exitCode = 1;
	} finally {
		lines.close();
	}
}

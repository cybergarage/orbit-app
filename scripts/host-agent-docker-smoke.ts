import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostAgentRun } from "../src/host-agent";
import { acquireHostSources, hostRepository } from "../src/host-core";
import { openHostAgentProfile } from "../src/host-profile";
import { Supervisor } from "../src/supervisor";
import { command, dockerPath } from "../src/worker";

const temp = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-agent-ci-")),
);
const profile = openHostAgentProfile(path.join(temp, "legacy"));
const projectProfile = { provider: "openai", model: "gpt-4o" };
const wire: unknown[] = [];
let allowModel: () => void = () => {};
const admitted = new Promise<void>((resolve) => {
	allowModel = resolve;
});
const sup = new Supervisor(
	profile,
	() => {},
	() => assert.fail("Host mode must not start the legacy Docker Agent"),
	async () => "",
	{ extract: async () => ({ text: '{"candidates":[]}' }) },
	{
		async catalog() {
			return {
				checkedAt: Date.now(),
				expiresAt: Date.now() + 15_000,
				providers: [
					{
						provider: "openai",
						label: "Synthetic OpenAI",
						status: "available",
						credential: "fixture",
						models: [{ ...projectProfile, label: "Fixture GPT", tools: true }],
					},
				],
			};
		},
		async request(_cwd, selection, route, body, signal) {
			assert.deepEqual(selection, projectProfile);
			assert.equal(route, "openai-chat");
			await admitted;
			signal.throwIfAborted();
			wire.push(body);
			return {
				id: "host-ci",
				object: "chat.completion",
				created: 0,
				model: "gpt-4o",
				usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
				choices: [
					wire.length === 1
						? {
								index: 0,
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									content: null,
									refusal: null,
									tool_calls: [
										{
											id: "call_host_ci_read",
											type: "function",
											function: {
												name: "read",
												arguments: JSON.stringify({ path: "fixture.txt" }),
											},
										},
									],
								},
							}
						: {
								index: 0,
								finish_reason: "stop",
								message: {
									role: "assistant",
									content: "Host Docker read fixture completed.",
									refusal: null,
								},
							},
				],
			};
		},
	},
	true,
);
try {
	await sup.init();
	const p = await sup.dispatch("create-project", {
		name: "Synthetic Host Agent",
	});
	const s = await sup.dispatch("create-session", { projectId: p.id });
	const { core, workspace } = sup.store.location(p.id, s.id);
	await fs.writeFile(
		path.join(workspace, "fixture.txt"),
		"Docker host route read this exact file.\n",
	);
	const stored = await hostRepository(core);
	assert.equal((await stored.findById(s.id))?.cwd, workspace);
	await sup.submit({
		projectId: p.id,
		sessionId: s.id,
		requestId: randomUUID(),
		prompt: "Synthetic read fixture.",
		...projectProfile,
	});
	const active = sup.store.state.active;
	const runner = sup.worker;
	assert.ok(runner instanceof HostAgentRun);
	assert.equal(active?.runtime, "host-v1");
	assert.equal(active.readerOwner, runner.name);
	assert.equal(active.containerName, undefined);
	allowModel();
	const deadline = Date.now() + 25_000;
	while (sup.store.state.active) {
		if (Date.now() > deadline)
			throw new Error("Host run did not clear its durable active marker");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(wire.length, 2);
	assert.match(
		JSON.stringify(wire[1]),
		/Docker host route read this exact file\./,
	);
	assert.equal(sup.store.session(p.id, s.id).status, "completed");
	const lease = await acquireHostSources(core, [s.id]);
	try {
		assert.ok(
			lease.captures[0]?.messages.some(
				(row) => row.text === "Host Docker read fixture completed.",
			),
		);
	} finally {
		await lease.release();
	}
	const remaining = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`label=org.cybergarage.orbit-app.workspace-parent=${runner.name}`,
		"--format",
		"{{.Names}}",
	]);
	assert.equal(remaining.trim(), "", "No owned reader may remain");
	const writer = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`name=^/${runner.name}$`,
		"--format",
		"{{.Names}}",
	]);
	assert.equal(writer.trim(), "", "Host route has no ordinary worker writer");
	console.log(
		"App supervisor, real Docker read, catalog-only metadata, host Core journal and teardown verified.",
	);
} finally {
	allowModel();
	await sup.close();
	await fs.rm(temp, { recursive: true, force: true });
}

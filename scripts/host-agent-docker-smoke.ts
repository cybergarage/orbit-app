import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerHostReader, HostAgentRun } from "../src/host-agent";
import { acquireHostSources, hostRepository } from "../src/host-core";
import { openHostAgentProfile } from "../src/host-profile";
import { Supervisor } from "../src/supervisor";
import { command, dockerPath } from "../src/worker";

const temp = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-agent-ci-")),
);
const profile = openHostAgentProfile(path.join(temp, "legacy"));
const tag = `orbit-app-host-reader-fixture:${randomUUID()}`;
const selection = { provider: "openai", model: "gpt-4o" };
const expected = [
	["read", { path: "fixture.txt" }],
	["list", { path: "." }],
	["glob", { path: ".", pattern: "*.txt" }],
	["grep", { path: ".", glob: "*.txt", pattern: "standalone" }],
] as const;
const wire: unknown[] = [];
let releaseModel: () => void = () => {};
const admitted = new Promise<void>((resolve) => {
	releaseModel = resolve;
});
let artifact: string | undefined;
let workspace: string | undefined;
let containers = 0;
const reader = createDockerHostReader(tag, async (exe, args, timeout) => {
	const output = await command(exe, args, timeout);
	if (args[0] !== "create") return output;
	const id = output.trim();
	const [created] = JSON.parse(await command(exe, ["inspect", id], 5_000));
	assert.equal(
		created.Image,
		artifact,
		"Runner must use the admitted immutable image ID",
	);
	assert.equal(created.HostConfig.NetworkMode, "none");
	assert.equal(created.HostConfig.ReadonlyRootfs, true);
	assert.deepEqual(
		created.Mounts.map(
			(mount: { Type: string; Destination: string; RW: boolean }) => [
				mount.Type,
				mount.Destination,
				mount.RW,
			],
		),
		[["bind", "/workspace", false]],
	);
	assert.ok(
		args.includes(
			`type=bind,src=${workspace},dst=/workspace,readonly,bind-recursive=disabled`,
		),
	);
	assert.ok(!args.includes("--env"));
	assert.ok(!args.includes("--env-file"));
	containers++;
	return output;
});
const supervisor = new Supervisor(
	profile,
	() => {},
	() => assert.fail("Host mode cannot start the legacy Agent"),
	async () => "",
	{ extract: async () => ({ text: '{"candidates":[]}' }) },
	{
		async catalog() {
			return {
				checkedAt: Date.now(),
				expiresAt: Date.now() + 15000,
				providers: [
					{
						provider: "openai",
						label: "Synthetic OpenAI",
						status: "available",
						credential: "fixture",
						models: [{ ...selection, label: "Fixture GPT", tools: true }],
					},
				],
			};
		},
		async request(_cwd, actual, route, body, signal) {
			assert.deepEqual(actual, selection);
			assert.equal(route, "openai-chat");
			await admitted;
			signal.throwIfAborted();
			wire.push(body);
			const tool = expected[wire.length - 1];
			return {
				id: "host-ci",
				object: "chat.completion",
				created: 0,
				model: "gpt-4o",
				usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
				choices: [
					tool
						? {
								index: 0,
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									content: null,
									refusal: null,
									tool_calls: [
										{
											id: `call_host_ci_${tool[0]}`,
											type: "function",
											function: {
												name: tool[0],
												arguments: JSON.stringify(tool[1]),
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
									content: "Standalone Docker reader fixture completed.",
									refusal: null,
								},
							},
				],
			};
		},
	},
	true,
	reader,
);
try {
	await command(
		dockerPath,
		["build", "-f", "worker/reader/Dockerfile", "-t", tag, "worker"],
		180_000,
	);
	artifact = await reader.admit();
	await supervisor.init();
	const p = await supervisor.dispatch("create-project", {
		name: "Synthetic Host Agent",
	});
	// Disable background automatic extraction; this fixture inspects the same
	// stored run immediately after release using a separate source-reader lease.
	await supervisor.dispatch("knowledge-control", {
		projectId: p.id,
		enabled: false,
	});
	const s = await supervisor.dispatch("create-session", { projectId: p.id });
	const own = supervisor.store.location(p.id, s.id);
	workspace = own.workspace;
	const fixture = path.join(workspace, "fixture.txt");
	await fs.writeFile(fixture, "Docker host route read this standalone file.\n");
	const stored = await hostRepository(own.core);
	assert.equal((await stored.findById(s.id))?.cwd, workspace);
	await supervisor.submit({
		projectId: p.id,
		sessionId: s.id,
		requestId: randomUUID(),
		prompt: "Synthetic standalone read fixture.",
		...selection,
	});
	const active = supervisor.store.state.active;
	const run = supervisor.worker;
	assert.ok(run instanceof HostAgentRun);
	assert.equal(active?.runtime, "host-v1");
	assert.equal(active.readerOwner, run.name);
	assert.equal(active.containerName, undefined);
	releaseModel();
	const deadline = Date.now() + 40_000;
	while (supervisor.store.state.active) {
		if (Date.now() > deadline)
			throw new Error("Host run did not clear its durable active marker");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(wire.length, expected.length + 1);
	assert.equal(containers, expected.length);
	const reads = [
		/Docker host route read this standalone file/,
		/fixture\.txt/,
		/fixture\.txt/,
		/Docker host route read this standalone file/,
	];
	for (const [index, [name]] of expected.entries()) {
		const payload = wire[index + 1] as {
			messages: Array<{
				role: string;
				tool_call_id?: string;
				content?: unknown;
			}>;
		};
		const observed = payload.messages.findLast(
			(message) => message.role === "tool",
		);
		assert.equal(observed?.tool_call_id, `call_host_ci_${name}`);
		assert.match(JSON.stringify(observed?.content), reads[index]);
	}
	assert.equal(supervisor.store.session(p.id, s.id).status, "completed");
	assert.deepEqual(await fs.readdir(workspace), ["fixture.txt"]);
	assert.equal(
		await fs.readFile(fixture, "utf8"),
		"Docker host route read this standalone file.\n",
	);
	const lease = await acquireHostSources(own.core, [s.id]);
	try {
		assert.ok(
			lease.captures[0]?.messages.some(
				(message) =>
					message.text === "Standalone Docker reader fixture completed.",
			),
		);
	} finally {
		await lease.release();
	}
	const remaining = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`label=org.cybergarage.orbit-app.workspace-parent=${run.name}`,
		"--format",
		"{{.Names}}",
	]);
	assert.equal(remaining.trim(), "", "No owned reader may remain");
	const writer = await command(dockerPath, [
		"ps",
		"-a",
		"--filter",
		`name=^/${run.name}$`,
		"--format",
		"{{.Names}}",
	]);
	assert.equal(writer.trim(), "", "Host route has no ordinary worker writer");
	await assert.rejects(fs.stat(path.join(profile, ".metadata-helper.json")), {
		code: "ENOENT",
	});
	await command(dockerPath, ["image", "rm", tag]);
	await assert.rejects(
		supervisor.submit({
			projectId: p.id,
			sessionId: s.id,
			requestId: randomUUID(),
			prompt: "Missing reader fixture must not fall back.",
			...selection,
		}),
		/standalone Docker reader/,
	);
	assert.equal(wire.length, expected.length + 1);
	assert.equal(containers, expected.length);
	console.log(
		"App Supervisor, native catalog, four standalone Docker reads, immutable image, isolated mounts, teardown and no fallback verified.",
	);
} finally {
	releaseModel();
	try {
		await supervisor.close();
	} finally {
		await command(dockerPath, ["image", "rm", tag]).catch(() => {});
		await fs.rm(temp, { recursive: true, force: true });
	}
}

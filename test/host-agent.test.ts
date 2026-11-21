import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HostAgentRun, type HostReader } from "../src/host-agent";
import {
	HostCoreNames,
	hostRepository,
	acquireHostSources,
} from "../src/host-core";
import { openHostAgentProfile } from "../src/host-profile";
import { encodeWorkspaceRequest } from "../src/workspace-request";

async function fixture(t: import("node:test").TestContext) {
	const base = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-host-fixture-")),
	);
	t.after(async () => fs.rm(base, { recursive: true, force: true }));
	const legacy = path.join(base, "legacy");
	await fs.mkdir(legacy);
	await fs.writeFile(path.join(legacy, "example"), "legacy untouched");
	const root = openHostAgentProfile(legacy);
	assert.equal(openHostAgentProfile(legacy), root);
	assert.equal(
		await fs.readFile(path.join(legacy, "example"), "utf8"),
		"legacy untouched",
	);
	const project = randomUUID();
	const workspace = path.join(root, "projects", project, "workspace");
	const core = path.join(root, "projects", project, "core");
	await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
	const catalogCalls: string[] = [];
	const names = new HostCoreNames(root, {
		async call(dir) {
			catalogCalls.push(dir);
			return { name: "Fixture", revision: 1 };
		},
	});
	await names.call(core, { command: "create-project" });
	const sessionId = randomUUID();
	await names.call(core, {
		command: "create-session",
		sessionId,
		hostWorkspace: workspace,
	});
	t.after(async () => names.close());
	assert.deepEqual(catalogCalls, [path.join(root, "catalog")]);
	return { root, workspace, core, names, sessionId };
}

function completion(name?: string, args?: unknown) {
	return {
		id: "fixture",
		object: "chat.completion",
		created: 0,
		model: "gpt-4o",
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		choices: [
			{
				index: 0,
				finish_reason: name ? "tool_calls" : "stop",
				message: name
					? {
							role: "assistant",
							content: null,
							refusal: null,
							tool_calls: [
								{
									id: `call_${randomUUID().replaceAll("-", "")}`,
									type: "function",
									function: { name, arguments: JSON.stringify(args) },
								},
							],
						}
					: {
							role: "assistant",
							content: "Host fixture completed",
							refusal: null,
						},
			},
		],
	};
}

test("isolated host-profile marker refuses unmarked, pre-existing directories", async (t) => {
	const base = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-profile-fixture-"),
	);
	t.after(async () => fs.rm(base, { recursive: true, force: true }));
	const target = path.join(base, "legacy-host-agent-native-v2");
	await fs.mkdir(target, { mode: 0o700 });
	await fs.writeFile(path.join(target, "sentinel"), "keep");
	assert.throws(
		() => openHostAgentProfile(path.join(base, "legacy")),
		/unmarked or unsafe/,
	);
	assert.deepEqual(await fs.readdir(target), ["sentinel"]);
});

test("real Core runs on the host with exactly four Docker read tools; merged settings cannot open Bash, writes or MCP", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(
		path.join(f.workspace, "note.txt"),
		"There is no local fallback.",
	);
	await fs.mkdir(path.join(f.workspace, ".orbit"));
	// Inert fixture; the Core host must not construct an MCP process here.
	await fs.writeFile(
		path.join(f.workspace, ".orbit/settings.json"),
		JSON.stringify({
			tools: { profile: "coding", include: ["bash", "write", "edit"] },
			mcp: {
				servers: {
					harmlessFixture: { command: process.execPath, args: ["--version"] },
				},
			},
		}),
	);
	const artifact = `sha256:${"c".repeat(64)}`;
	const frames: Array<{ name: string; target: string }> = [];
	const reaped: string[] = [];
	const reader: HostReader = {
		admit: async () => artifact,
		read: async (_parent, workspace, image, op) => {
			assert.equal(workspace, f.workspace);
			assert.equal(image, artifact);
			frames.push(JSON.parse(encodeWorkspaceRequest(workspace, op)));
			return {
				content: [{ type: "text", text: "synthetic Docker observation" }],
			};
		},
		stop: async (parent) => {
			reaped.push(parent);
		},
	};
	const wire: any[] = [];
	const events: any[] = [];
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Synthetic isolated read.",
		},
		(e) => events.push(e),
		async (route, body) => {
			assert.equal(route, "openai-chat");
			wire.push(body);
			switch (wire.length) {
				case 1:
					return completion("read", { path: "note.txt" });
				case 2:
					return completion("write", {
						path: "should-not-exist.txt",
						content: "not written",
					});
				case 3:
					return completion("bash", { command: "printf 'not executed'" });
				default:
					return completion();
			}
		},
		reader,
	);
	await run.start();
	await run.confirmGone();
	assert.deepEqual(
		wire[0].tools.map((tool: any) => tool.function.name).sort(),
		["glob", "grep", "list", "read"],
	);
	assert.match(JSON.stringify(wire[1]), /synthetic Docker observation/);
	assert.deepEqual(
		frames.map((op) => [op.name, op.target]),
		[["read", "/workspace/note.txt"]],
	);
	assert.deepEqual(reaped, [run.name]);
	assert.equal(
		events.find((event) => event.type === "result")?.data?.runtime?.outcome,
		"completed",
	);
	assert.equal(
		events.some((event) => event.type === "approval"),
		false,
	);
	await assert.rejects(
		fs.access(path.join(f.workspace, "should-not-exist.txt")),
		{ code: "ENOENT" },
	);
	const repo = await hostRepository(f.core);
	const found = await repo.findById(f.sessionId);
	assert.equal(found?.cwd, f.workspace);
	assert.equal(found?.originator, "orbit-app-host-v1");
	const lease = await acquireHostSources(f.core, [f.sessionId]);
	try {
		assert.ok(
			lease.captures[0]?.messages.some(
				(message) => message.text === "Host fixture completed",
			),
		);
	} finally {
		await lease.release();
	}
});

test("stale or missing Docker backend fails before any model or host file operation", async (t) => {
	const f = await fixture(t);
	const run = new HostAgentRun(
		f.workspace,
		f.core,
		{
			sessionId: f.sessionId,
			requestId: randomUUID(),
			model: "gpt-4o",
			provider: "openai",
			prompt: "Never dispatched.",
		},
		() => {},
		async () => assert.fail("provider cannot run after failed admission"),
		{
			admit: async () => {
				throw new Error("stale reader image");
			},
			read: async () => assert.fail("read cannot run after failed admission"),
			stop: async () => assert.fail("no child was admitted"),
		},
	);
	await assert.rejects(run.start(), /stale reader image/);
	await run.confirmGone();
});

test("temporary catalog helper is shaped without a state or workspace mount", async (t) => {
	const f = await fixture(t);
	const catalog = path.join(f.root, "catalog");
	await fs.mkdir(catalog, { recursive: true, mode: 0o700 });
	const { runMetadataHelper } = await import("../src/metadata-helper");
	let createCalls = 0;
	const transport = {
		async command(args: string[]) {
			if (args[0] !== "create") return "";
			createCalls++;
			assert.deepEqual(
				args.flatMap((arg, index) =>
					arg === "--mount" ? [args[index + 1]] : [],
				),
				[`type=bind,src=${catalog},dst=/catalog`],
			);
			assert.equal(args.at(-1), "/opt/worker/names.mjs");
			throw new Error("Stop after inspecting synthetic create args");
		},
		start() {
			return assert.fail("No synthetic catalog child starts in this test");
		},
	};
	await assert.rejects(
		runMetadataHelper(
			f.root,
			catalog,
			{ command: "create-project" },
			{ catalogOnly: true, transport },
		),
		/after inspecting synthetic create args/,
	);
	await assert.rejects(
		runMetadataHelper(
			f.root,
			f.core,
			{ command: "create-session" },
			{ catalogOnly: true, transport },
		),
		/cannot access sessions/,
	);
	assert.equal(createCalls, 1);
});

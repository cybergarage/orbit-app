import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";

const model = { provider: "openai", model: "gpt-4o" };
const key = "synthetic-packaged-fixture-not-a-credential";
const dockerPath = "/usr/local/bin/docker";
const pathEnv = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin";
const readerTools = ["glob", "grep", "list", "read"];

function docker(args, env, timeout = 10_000) {
	const result = spawnSync(dockerPath, args, {
		timeout,
		env,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		killSignal: "SIGKILL",
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function fixtureProvider() {
	const requests = [];
	let tools = [];
	let expected = [];
	let failure;
	const server = createServer(async (req, res) => {
		try {
			assert.equal(req.headers.authorization, `Bearer ${key}`);
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/models" && req.method === "GET") {
				res.end(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: model.model,
								object: "model",
								created: 0,
								owned_by: "fixture",
							},
						],
					}),
				);
				return;
			}
			assert.equal(req.url, "/v1/chat/completions");
			assert.equal(req.method, "POST");
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				size += chunk.length;
				assert.ok(
					size <= 256 * 1024,
					"Synthetic request was unexpectedly large",
				);
				chunks.push(chunk);
			}
			const request = JSON.parse(Buffer.concat(chunks));
			assert.equal(request.model, model.model);
			assert.deepEqual(
				(request.tools ?? []).map((tool) => tool.function.name).sort(),
				tools,
			);
			assert.ok(expected.length > 0, "Unexpected chat request");
			requests.push(request);
			const [name, args] = expected.shift();
			const message = name
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
						content: "Synthetic package fixture complete.",
						refusal: null,
					};
			res.end(
				JSON.stringify({
					id: "fixture",
					object: "chat.completion",
					created: 0,
					model: model.model,
					usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
					choices: [
						{ index: 0, finish_reason: name ? "tool_calls" : "stop", message },
					],
				}),
			);
		} catch (error) {
			failure ??= error;
			res.statusCode = 400;
			res.end(
				JSON.stringify({
					error: { message: "Synthetic fixture rejected a request" },
				}),
			);
		}
	});
	return {
		server,
		requests,
		plan(names, sequence) {
			tools = [...names].sort();
			expected = [...sequence];
		},
		verify() {
			assert.ifError(failure);
			assert.equal(expected.length, 0, "Missing synthetic model requests");
		},
	};
}

function snapshot(page) {
	return page.evaluate(() => window.orbit.call("snapshot"));
}

async function until(read, state) {
	const deadline = performance.now() + 30_000;
	while (performance.now() < deadline) {
		const result = await read();
		if (result) return result;
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${state}`);
}

function waitIdle(page) {
	return until(async () => !(await snapshot(page)).active, "run cleanup");
}

function checkGone(env, owner) {
	assert.match(owner, /^orbit-app-[a-f0-9-]{36}$/);
	assert.equal(
		docker(
			[
				"ps",
				"-a",
				"--filter",
				`label=org.cybergarage.orbit-app.workspace-parent=${owner}`,
				"--format",
				"{{.Names}}",
			],
			env,
		),
		"",
	);
}

function imageId(env, ref) {
	return docker(
		[
			"image",
			"ls",
			"--no-trunc",
			"--filter",
			`reference=${ref}`,
			"--format",
			"{{.ID}}",
		],
		env,
	);
}

// This opt-in smoke refuses to replace either local App runner tag. It
// releases only tags that still resolve to the exact images it built.
function releaseImages(env, images) {
	for (const { unique, alias, id, aliased } of images.reverse()) {
		for (const ref of [...(aliased ? [alias] : []), unique])
			if (imageId(env, ref) === id)
				docker(["image", "rm", "--no-prune", ref], env);
	}
}

export async function verifyPackagedWorkspaceWrites(
	executablePath,
	scratch,
	root,
) {
	const home = path.join(scratch, "test-home");
	await fs.mkdir(home, { mode: 0o700 });
	const endpoint = docker([
		"context",
		"inspect",
		"--format",
		"{{.Endpoints.docker.Host}}",
	]);
	assert.match(endpoint, /^unix:\/\/\/[^ \r\n]+$/);
	const env = {
		HOME: home,
		TMPDIR: scratch,
		PATH: pathEnv,
		DOCKER_HOST: endpoint,
	};
	const base = path.join(scratch, "legacy");
	const profile = `${base}-host-agent-native-v2`;
	const provider = fixtureProvider();
	const { server } = provider;
	const images = [];
	const expectedImages = [
		{
			alias: "orbit-app-workspace-reader:local",
			kind: "reader",
			build: [
				"-f",
				path.join(root, "worker/reader/Dockerfile"),
				path.join(root, "worker"),
			],
		},
		{
			alias: "orbit-app-workspace:local",
			kind: "writer",
			build: ["--network=none", path.join(root, "worker/workspace")],
		},
	];
	let app;
	try {
		for (const { alias } of expectedImages)
			assert.equal(
				imageId(env, alias),
				"",
				`The packaged fixture requires an unused local tag: ${alias}`,
			);
		for (const { alias, kind, build } of expectedImages) {
			const unique = `orbit-app-packaged-${kind}-fixture:${randomUUID()}`;
			docker(["build", "--tag", unique, ...build], env, 150_000);
			const id = imageId(env, unique);
			assert.match(id, /^sha256:[a-f0-9]{64}$/);
			const entry = { alias, unique, id, aliased: false };
			images.push(entry);
			assert.equal(
				imageId(env, alias),
				"",
				`The local alias became occupied: ${alias}`,
			);
			docker(["image", "tag", id, alias], env);
			entry.aliased = true;
		}
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const launch = (host, writes) =>
			electron.launch({
				executablePath,
				env: {
					...env,
					ORBIT_APP_TEST: "1",
					ORBIT_APP_DATA: base,
					ORBIT_APP_NO_HEALTH_TEST: "1",
					ORBIT_APP_LIVE: "0",
					ORBIT_APP_HOST_AGENT: host ? "1" : "0",
					ORBIT_APP_HOST_AGENT_FILE_CHANGES: writes ? "1" : "0",
					OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
					OPENAI_API_KEY: key,
				},
				timeout: 25_000,
			});
		await fs.mkdir(base, { mode: 0o700 });
		app = await launch(false, true);
		let page = await app.firstWindow();
		assert.equal(
			(await snapshot(page)).executionBackend,
			undefined,
			"Writer flag alone must not change the default mode",
		);
		await app.close();
		app = undefined;
		assert.equal(provider.requests.length, 0);

		app = await launch(true, true);
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, "host-files");
		const { projectId, sessionId } = await page.evaluate(async () => {
			const p = await window.orbit.call("create-project", {
				name: "Synthetic packaged approval project",
			});
			await window.orbit.call("knowledge-control", {
				projectId: p.id,
				enabled: false,
			});
			const s = await window.orbit.call("create-session", { projectId: p.id });
			return { projectId: p.id, sessionId: s.id };
		});
		const readSession = async () =>
			(await snapshot(page)).projects
				.find((p) => p.id === projectId)
				.sessions.find((s) => s.id === sessionId);
		const workspace = (await readSession()).workspace;
		assert.ok(
			workspace.startsWith(profile + path.sep),
			"Only the disposable profile workspace may be used",
		);
		const file = path.join(workspace, "fixture.txt");
		const denied = path.join(workspace, "denied.txt");
		await page.getByRole("button", { name: "Chat 1", exact: true }).click();
		provider.plan(
			[...readerTools, "edit", "write"],
			[
				["write", { path: "denied.txt", content: "denied" }],
				["write", { path: "fixture.txt", content: "approved before" }],
				["edit", { path: "fixture.txt", oldText: "before", newText: "after" }],
				[undefined],
			],
		);
		const submit = (prompt) =>
			page.evaluate((input) => window.orbit.call("submit", input), {
				projectId,
				sessionId,
				requestId: randomUUID(),
				prompt,
				...model,
			});
		await submit("Exercise approved file changes in a synthetic workspace.");
		let previous;
		let owner;
		for (const [index, name, target, button] of [
			[0, "write", "denied.txt", "Deny"],
			[1, "write", "fixture.txt", "Approve"],
			[2, "edit", "fixture.txt", "Approve"],
		]) {
			const expectedPath = path.join(workspace, target);
			// Playwright's polling predicate is synchronous. Poll the
			// asynchronous renderer IPC snapshot in this test process.
			const approval = await until(async () => {
				const chat = await readSession();
				const current = chat.events.findLast(
					(event) => event.type === "approval",
				)?.data;
				return (
					chat.status === "awaiting-approval" &&
					current?.id !== previous &&
					current?.preview?.path === expectedPath &&
					current.preview.name === name &&
					current
				);
			}, `${name} approval for ${target}`);
			await page
				.getByText("Review operation", { exact: true })
				.waitFor({ state: "visible", timeout: 10_000 });
			previous = approval.id;
			assert.equal(approval.preview.name, name);
			assert.equal(approval.preview.path, path.join(workspace, target));
			// State over IPC can advance before the renderer commits its next frame.
			const preview = page
				.locator(".approval pre")
				.filter({ hasText: JSON.stringify(approval.preview.path) })
				.filter({ hasText: `"name": "${name}"` });
			await preview.waitFor({ state: "visible", timeout: 10_000 });
			const active = (await snapshot(page)).active;
			owner = active.readerOwner;
			assert.equal(active.containerName, undefined);
			assert.equal(active.workspaceMutations, true);
			checkGone(env, owner);
			await assert.rejects(fs.stat(denied), { code: "ENOENT" });
			if (index < 2) await assert.rejects(fs.stat(file), { code: "ENOENT" });
			else assert.equal(await fs.readFile(file, "utf8"), "approved before");
			if (index === 0)
				await assert.rejects(
					page.evaluate(
						(id) => window.orbit.call("approve", { id, approve: true }),
						randomUUID(),
					),
					/Approval is no longer pending/,
				);
			await page.getByRole("button", { name: button, exact: true }).click();
		}
		await waitIdle(page);
		provider.verify();
		assert.equal(provider.requests.length, 4);
		const outcomes = provider.requests
			.slice(1)
			.map(
				(req) =>
					req.messages.findLast((message) => message.role === "tool")?.content,
			);
		assert.match(JSON.stringify(outcomes[0]), /Operation denied/);
		for (const outcome of outcomes.slice(1))
			assert.match(JSON.stringify(outcome), /Workspace mutation completed/);
		assert.equal((await readSession()).status, "completed");
		assert.equal(await fs.readFile(file, "utf8"), "approved after");
		assert.deepEqual(await fs.readdir(workspace), ["fixture.txt"]);
		checkGone(env, owner);
		await app.close();
		app = undefined;

		app = await launch(true, false);
		page = await app.firstWindow();
		assert.equal((await snapshot(page)).executionBackend, "host-readonly");
		assert.equal(
			(await readSession()).answer,
			"Synthetic package fixture complete.",
		);
		assert.equal(await fs.readFile(file, "utf8"), "approved after");
		provider.plan(readerTools, [[undefined]]);
		await submit("Confirm read-only capability after restart.");
		await waitIdle(page);
		provider.verify();
		assert.equal(provider.requests.length, 5);
		assert.equal((await readSession()).status, "completed");
		checkGone(env, owner);
		console.log(
			"Packaged Orbit App: approval UI/IPC, denial, approved write/edit, Docker cleanup, restart and reader-only tool gate verified.",
		);
	} finally {
		try {
			await app?.close();
		} finally {
			try {
				if (server.listening)
					await new Promise((resolve) => server.close(resolve));
			} finally {
				releaseImages(env, images);
			}
		}
	}
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, dockerPath, Worker } from "../src/worker";

const id = randomUUID();
const images = ["worker", "runner", "stale", "unacknowledged", "slow"].map(
	(role) => `orbit-app-route-smoke-${role}:${id}`,
);
const [workerImage, runnerImage, staleImage, unacknowledged, slowImage] =
	images;
const root = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-route-smoke-")),
);
const docker = (args: string[], timeout = 8_000) =>
	command(dockerPath, args, timeout);

const toolChoice = (name: string, args: object) => ({
	finish_reason: "tool_calls",
	message: {
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
	},
});
const note = { path: "/workspace/note.txt" };
const write = toolChoice("write", { ...note, content: "fixture initial" });
const edit = toolChoice("edit", {
	...note,
	oldText: "initial",
	newText: "updated",
});
const read = toolChoice("read", note);
const completed = {
	finish_reason: "stop",
	message: {
		role: "assistant",
		content: "Synthetic Docker route complete",
		refusal: null,
	},
};

async function exercise(
	name: string,
	choice: object[],
	optIn: boolean,
	options: {
		worker?: string;
		runner?: string;
		cancel?: boolean;
		uncertain?: boolean;
		missingRunner?: boolean;
	} = {},
) {
	const workspace = path.join(root, name, "workspace");
	const state = path.join(root, name, "state");
	await fs.mkdir(workspace, { recursive: true });
	await fs.mkdir(state);
	const events: any[] = [],
		calls: string[][] = [],
		inputs: string[] = [];
	let modelCalls = 0;
	let admitted: () => void = () => {};
	const childCreated = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	const worker = new Worker(
		workspace,
		state,
		{
			sessionId: randomUUID(),
			requestId: randomUUID(),
			provider: "openai",
			model: "gpt-4o",
			prompt: "Synthetic local Docker test; no network or paid model.",
			workspaceMutations: optIn,
		},
		(event) => {
			events.push(event);
			if (event.type === "approval") worker.approve(event.data.id, true);
		},
		{
			async request(route, body) {
				assert.equal(route, "openai-chat");
				inputs.push(JSON.stringify(body));
				const next = choice[modelCalls++];
				assert.ok(next, "Unexpected model call or automatic replay");
				return {
					id: "synthetic",
					object: "chat.completion",
					created: 0,
					model: "gpt-4o",
					choices: [{ index: 0, ...next }],
					usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
				};
			},
		},
		{
			workerImage: options.worker ?? workerImage,
			mutationImage: options.runner ?? runnerImage,
			async command(executable, args, timeout) {
				calls.push(args);
				const result = await command(executable, args, timeout);
				if (args[0] === "create") admitted();
				return result;
			},
		},
	);
	const tolerateGuard = (error: unknown) => {
		if (!options.uncertain && !options.cancel) throw error;
		assert.match(String(error), /writer ownership remains/);
	};
	const stop = () => worker.stop().catch(tolerateGuard);
	const started = performance.now();
	try {
		if (options.worker === staleImage) {
			await assert.rejects(worker.start(), /compatible Docker worker image/);
			assert.equal(modelCalls, 0);
			assert.deepEqual(await fs.readdir(state), []);
			assert.equal(calls.length, 1);
		} else if (options.missingRunner) {
			await assert.rejects(worker.start(), /compatible Docker workspace runner image/);
			assert.equal(modelCalls, 0);
			assert.deepEqual(await fs.readdir(state), []);
			assert.equal(calls.length, 2);
		} else {
			const running = worker.start();
			if (options.cancel) {
				await Promise.race([
					childCreated,
					running.then(() => assert.fail("Child not created before worker exit")),
				]);
				await new Promise((resolve) => setTimeout(resolve, 500));
				await stop();
			}
			await running.catch((error) => {
				throw new Error(`${String(error)}: ${JSON.stringify(events)}`);
			});
		}
	} finally {
		await stop();
		await worker.confirmGone().catch(tolerateGuard);
	}
	if (options.uncertain || options.cancel)
		assert.ok(performance.now() - started < 25_000, "Cleanup exceeded fixture deadline");
	assert.equal(
		(await docker([
			"ps", "-a", "--filter",
			`label=org.cybergarage.orbit-app.workspace-parent=${worker.name}`,
			"--format", "{{.Names}}",
		])).trim(),
		"",
		"No workspace-only child may remain after settlement",
	);
	return {
		runtime: events.find((event) => event.type === "result")?.data?.runtime,
		events,
		inputs,
		calls,
		creates: calls.filter((args) => args[0] === "create").length,
		read: () => fs.readFile(path.join(workspace, "note.txt"), "utf8"),
	};
}

try {
	await docker(["build", "--tag", workerImage, "worker"], 180_000);
	await docker(
		["build", "--network=none", "--tag", runnerImage, "worker/workspace"],
		120_000,
	);
	for (const [tag, from, body] of [
		[staleImage, workerImage, 'LABEL org.cybergarage.orbit-app.workspace-mutations="0"'],
		[unacknowledged, runnerImage, 'ENTRYPOINT ["sh", "-c", "node /opt/workspace-mutation.mjs >/dev/null"]'],
		[slowImage, runnerImage, 'ENTRYPOINT ["node", "-e", "setTimeout(() => {}, 60000)"]'],
	]) {
		await fs.writeFile(path.join(root, "Dockerfile"), `FROM ${from}\n${body}\n`);
		await docker(["build", "--network=none", "--tag", tag, root], 120_000);
	}

	const gated = await exercise("stale", [], true, { worker: staleImage });
	assert.equal(gated.creates, 0);
	const missing = await exercise("missing-runner", [], true, {
		runner: `orbit-app-route-smoke-absent:${id}`,
		missingRunner: true,
	});
	assert.equal(missing.creates, 0);
	const standard = await exercise("default", [write, completed], false);
	assert.equal(standard.runtime?.outcome, "completed", JSON.stringify(standard.events));
	assert.equal(standard.calls.length, 0);
	assert.equal(await standard.read(), "fixture initial");

	const routed = await exercise("routed", [write, edit, read, completed], true);
	assert.equal(routed.runtime?.outcome, "completed", JSON.stringify(routed.events));
	assert.equal(await routed.read(), "fixture updated");
	assert.equal(routed.creates, 2, "Only write and edit use the runner");
	assert.ok(routed.inputs.at(-1)?.includes("fixture updated"));

	const unknown = await exercise("unacknowledged", [write], true, {
		runner: unacknowledged,
		uncertain: true,
	});
	assert.equal(await unknown.read(), "fixture initial", "Commit did occur");
	assert.equal(unknown.creates, 1, "Lost acknowledgment must never replay a write");
	assert.equal(unknown.inputs.length, 1, "Core stops after an uncertain write");
	assert.ok(
		unknown.runtime?.operations.some((operation: any) => operation.status === "unknown"),
		JSON.stringify(unknown.events),
	);

	const cancelled = await exercise("cancelled", [write, completed], true, {
		runner: slowImage,
		cancel: true,
	});
	assert.equal(cancelled.creates, 1);
	await assert.rejects(cancelled.read(), { code: "ENOENT" });
	console.log(
		"Verified real App Docker worker: stale image rejected; default preserved; write/edit only; committed-but-unacknowledged and cancelled runner cleaned without replay.",
	);
} finally {
	for (const image of images.toReversed())
		await docker(["image", "rm", image]).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
}

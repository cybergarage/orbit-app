import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { dockerWorkspaceArgs } from "../src/worker";
import {
	executeWorkspaceObservation,
	type MutationPorts,
} from "../src/workspace-mutation-client";

const root = "/private/generated/project";
const target = "/workspace/fixture";
const operation = {
	version: 1,
	effect: "read",
	name: "read",
	cwd: "/workspace",
	target,
	input: { path: target },
} as const;
function fixture(
	attached: NonNullable<MutationPorts["attached"]>,
	owned = true,
) {
	const id = randomUUID();
	const parent = `orbit-app-${id}`;
	const name = `orbit-app-workspace-${id}-read`;
	const immutable = `sha256:${"a".repeat(64)}`;
	let exists = false;
	const types: string[] = [];
	const ports: MutationPorts = {
		docker: "synthetic-docker",
		args: (child, workspace) =>
			dockerWorkspaceArgs(child, workspace, immutable, true),
		async command(_exe, args) {
			types.push(args[0]);
			switch (args[0]) {
				case "create": {
					assert.equal(args[args.indexOf("--name") + 1], name);
					assert.deepEqual(
						args.flatMap((arg, i) => (arg === "--mount" ? [args[i + 1]] : [])),
						[
							`type=bind,src=${root},dst=/workspace,readonly,bind-recursive=disabled`,
						],
					);
					assert.ok(args.includes("--read-only"));
					assert.ok(args.includes("--pull=never"));
					assert.equal(args[args.indexOf("--network") + 1], "none");
					assert.ok(!args.includes("--privileged"));
					assert.deepEqual(args.slice(-4), [
						"--entrypoint",
						"node",
						immutable,
						"/opt/worker/workspace-reader.mjs",
					]);
					exists = true;
					return "a".repeat(64);
				}
				case "inspect":
					return owned ? parent : "unexpected";
				case "rm":
					exists = false;
					return "";
				case "ps":
					return exists ? name : "";
				default:
					throw new Error("Unexpected fixture command");
			}
		},
		attached,
	};
	return {
		types,
		request: (signal = new AbortController().signal) =>
			executeWorkspaceObservation(parent, root, operation, signal, ports),
	};
}

test("read-only mount is nonrecursive and preserves Core-shaped output larger than mutation replies", async () => {
	const answer = {
		content: [{ type: "text", text: "\t".repeat(100_000) }],
		details: {
			encoding: "utf8",
			path: target,
			startLine: 1,
			endLine: 1,
			totalLines: 1,
			truncated: false,
		},
	};
	const f = fixture(async (_docker, _id, wire) => {
		assert.deepEqual(JSON.parse(wire), operation);
		return answer;
	});
	assert.deepEqual(await f.request(), answer);
	assert.deepEqual(f.types, ["create", "ps", "inspect", "rm", "ps"]);
});

test("expired, malformed and oversized read replies are settled failures after verified cleanup", async () => {
	for (const attached of [
		async () => {
			throw new Error("Synthetic deadline");
		},
		async () => ({
			content: [{ type: "text", text: "data" }],
			details: { private: true },
		}),
		async () => ({
			content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
			isError: true,
		}),
	]) {
		const f = fixture(attached);
		assert.match(JSON.stringify(await f.request()), /"isError":true/);
		assert.deepEqual(f.types, ["create", "ps", "inspect", "rm", "ps"]);
	}
});

test("cancel before start creates nothing; never reap a foreign container", async () => {
	const f = fixture(async () => assert.fail("must not start"));
	assert.match(
		JSON.stringify(await f.request(AbortSignal.abort())),
		/"isError":true/,
	);
	assert.deepEqual(f.types, []);
	const foreign = fixture(async () => {
		throw new Error("Synthetic deadline");
	}, false);
	await assert.rejects(foreign.request(), /ownership mismatch/);
	assert.deepEqual(foreign.types, ["create", "ps", "inspect"]);
});

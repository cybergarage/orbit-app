import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
	executeWorkspaceMutation,
	type MutationPorts,
} from "../src/workspace-mutation-client";

const operation = {
	version: 1,
	name: "write",
	effect: "write",
	cwd: "/workspace",
	target: "/workspace/test.txt",
	preimageSha256: null,
	resultSha256: "0".repeat(64),
	input: { path: "/workspace/test.txt", content: "generated" },
} as const;

function fixture(
	attached: NonNullable<MutationPorts["attached"]>,
	ownerMatches = true,
) {
	const parent = `orbit-app-${randomUUID()}`;
	const path = "/synthetic/approved";
	const types: string[] = [];
	let exists = false;
	const ports: MutationPorts = {
		docker: "synthetic-docker",
		args: (name, root) => [
			"run",
			"--name",
			name,
			"--mount",
			root,
			"fixture-image",
		],
		async command(exe, args) {
			assert.equal(exe, "synthetic-docker");
			types.push(args[0]);
			switch (args[0]) {
				case "create":
					assert.ok(args.includes(path));
					assert.ok(
						args.includes(
							`org.cybergarage.orbit-app.workspace-parent=${parent}`,
						),
					);
					exists = true;
					return "a".repeat(64);
				case "inspect":
					return ownerMatches ? parent : "other";
				case "rm":
					exists = false;
					return "";
				case "ps":
					return exists ? "child" : "";
				default:
					throw new Error("Unexpected Docker command");
			}
		},
		attached,
	};
	return {
		types,
		call: (signal = new AbortController().signal) =>
			executeWorkspaceMutation(parent, path, operation, signal, ports),
	};
}

test("starts exactly one acknowledged container and returns only its bounded reply", async () => {
	const value = { content: [{ type: "text", text: "done" }] };
	const f = fixture(async (_exe, id, frame) => {
		assert.equal(id, "a".repeat(64));
		assert.deepEqual(JSON.parse(frame), operation);
		return value;
	});
	assert.deepEqual(await f.call(), value);
	assert.deepEqual(f.types, ["create", "ps", "inspect", "rm", "ps"]);
});

test("uncertain mutation and malformed reply cannot trigger execution or replay after teardown", async () => {
	for (const attached of [
		async () => {
			throw new Error("Synthetic timeout; no reply");
		},
		async () => ({
			content: [{ type: "text", text: "done", extra: "not permitted" }],
		}),
	]) {
		let attempts = 0;
		const f = fixture(async () => {
			attempts++;
			return attached();
		});
		await assert.rejects(f.call());
		assert.equal(attempts, 1);
		assert.deepEqual(f.types, ["create", "ps", "inspect", "rm", "ps"]);
	}
});

test("fails closed on mismatched ownership and does not remove another child's container", async () => {
	const f = fixture(
		async () => ({ content: [{ type: "text", text: "done" }] }),
		false,
	);
	await assert.rejects(f.call(), /ownership mismatch/);
	assert.deepEqual(f.types, ["create", "ps", "inspect"]);
});

test("cancelled admission creates nothing", async () => {
	const f = fixture(async () =>
		assert.fail("Cancelled request must not start"),
	);
	await assert.rejects(f.call(AbortSignal.abort()));
	assert.deepEqual(f.types, []);
});

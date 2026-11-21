import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceMutationExecutor } from "./workspace-mutation-executor.mjs";

test("an older all-tools Core cannot silently admit the opt-in", async () => {
	const rpc = async () =>
		assert.fail("The compatibility check must not dispatch");
	await assert.rejects(
		createWorkspaceMutationExecutor(rpc, (value) => ({
			execute: value.execute,
		})),
		/selective workspace routing/,
	);
});

test("the worker opts into only write/edit and forwards the active signal", async () => {
	const operation = { version: 1, name: "write", effect: "write" };
	const signal = new AbortController().signal;
	const expected = { content: [{ type: "text", text: "ack" }] };
	const executor = await createWorkspaceMutationExecutor(
		async (...args) => {
			assert.deepEqual(args, ["workspace-mutation", operation, signal]);
			return expected;
		},
		(value) => value,
	);
	assert.deepEqual(executor.toolNames, ["write", "edit"]);
	assert.equal(await executor.execute(operation, signal), expected);
});

test("reader routes independently; combining it with mutations still excludes shell", async () => {
	const capture = (value) => value;
	for (const mutations of [false, true]) {
		const calls = [];
		const executor = await createWorkspaceMutationExecutor(
			(route) => calls.push(route),
			capture,
			{ reads: true, mutations },
		);
		assert.deepEqual(executor.toolNames, [
			...(mutations ? ["write", "edit"] : []),
			"read",
			"list",
			"glob",
			"grep",
		]);
		executor.execute({ name: "read", effect: "read" });
		if (mutations) executor.execute({ name: "edit", effect: "write" });
		assert.deepEqual(calls, [
			"workspace-observation",
			...(mutations ? ["workspace-mutation"] : []),
		]);
	}
});

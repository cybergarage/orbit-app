import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { dockerArgs, dockerWorkspaceArgs } from "../src/worker";
import { encodeWorkspaceRequest } from "../src/workspace-request";

const workspace = "/synthetic/repository";
const target = `${workspace}/docs/note.txt`;
const read = {
	version: 1,
	name: "read",
	effect: "read",
	cwd: workspace,
	target,
	input: { path: target, limit: 3 },
} as const;

test("Docker workspace launch plan mounts only the selected workspace and retains isolation", () => {
	const args = dockerWorkspaceArgs(
		`orbit-app-workspace-${randomUUID()}`,
		workspace,
	);
	assert.deepEqual(
		args.flatMap((arg, i) => (arg === "--mount" ? [args[i + 1]] : [])),
		[`type=bind,src=${workspace},dst=/workspace`],
	);
	assert.equal(args[args.indexOf("--network") + 1], "none");
	assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
	assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
	assert.equal(args[args.indexOf("--workdir") + 1], "/workspace");
	assert.ok(args.includes("--read-only"));
	assert.ok(args.includes("--pull=never"));
	assert.ok(!args.includes("--privileged"));
	assert.ok(!args.includes("--env"));
	assert.ok(
		dockerArgs("legacy", workspace, "/synthetic/core").includes(
			"type=bind,src=/synthetic/core,dst=/state",
		),
	);
	assert.throws(
		() =>
			dockerWorkspaceArgs(
				`orbit-app-workspace-${randomUUID()}`,
				`${workspace},dst=/state`,
			),
		/Invalid workspace mount path/,
	);
});

test("prepared read remaps only the approved root and target", () => {
	const encoded = encodeWorkspaceRequest(workspace, read);
	assert.deepEqual(JSON.parse(encoded), {
		version: 1,
		name: "read",
		effect: "read",
		cwd: "/workspace",
		target: "/workspace/docs/note.txt",
		input: { path: "/workspace/docs/note.txt", limit: 3 },
	});
	assert.ok(!encoded.includes(workspace));
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...read,
				target: `${workspace}-sibling/note`,
			}),
		/outside the bound workspace/,
	);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...read,
				input: { path: `${workspace}/different` },
			}),
		/input and target disagree/,
	);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...read,
				input: { ...read.input, session: "not transported" },
			}),
		/Invalid prepared workspace input/,
	);
});

test("mutation digests are preserved; inconsistent effect or oversized input is denied", () => {
	const write = {
		...read,
		name: "write",
		effect: "write",
		input: { path: target, content: "text" },
		preimageSha256: null,
		resultSha256: "a".repeat(64),
	} as const;
	const request = JSON.parse(encodeWorkspaceRequest(workspace, write));
	assert.equal(request.preimageSha256, null);
	assert.equal(request.resultSha256, write.resultSha256);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...write,
				resultSha256: "not-a-digest",
			}),
		/missing its digest/,
	);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...write,
				effect: "read",
			}),
		/Invalid prepared workspace operation/,
	);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...write,
				input: { path: target, content: "x".repeat(1024 * 1024) },
			}),
		/exceeds byte limit/,
	);
});

test("Bash uses only the approved current directory", () => {
	const bash = {
		version: 1,
		name: "bash",
		effect: "command",
		cwd: workspace,
		target: workspace,
		input: { command: "printf ok", timeoutSeconds: 1 },
	} as const;
	assert.equal(
		JSON.parse(encodeWorkspaceRequest(workspace, bash)).target,
		"/workspace",
	);
	assert.throws(
		() =>
			encodeWorkspaceRequest(workspace, {
				...bash,
				target,
			}),
		/bound working directory/,
	);
});

test("every managed file tool uses the same approved path translation", () => {
	const tools = [
		{ name: "read", effect: "read", input: { path: target } },
		{
			name: "list",
			effect: "read",
			input: { path: target, includeHidden: true },
		},
		{
			name: "glob",
			effect: "read",
			input: { path: target, pattern: ["*.txt"] },
		},
		{ name: "grep", effect: "read", input: { path: target, pattern: "note" } },
		{
			name: "edit",
			effect: "write",
			input: { path: target, oldText: "before", newText: "after" },
			preimageSha256: "a".repeat(64),
			resultSha256: "b".repeat(64),
		},
		{
			name: "write",
			effect: "write",
			input: { path: target, content: "after" },
			preimageSha256: null,
			resultSha256: "b".repeat(64),
		},
	] as const;
	for (const tool of tools) {
		const encoded = encodeWorkspaceRequest(workspace, { ...read, ...tool });
		assert.equal(JSON.parse(encoded).input.path, "/workspace/docs/note.txt");
	}
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeWorkspaceObservation } from "../src/workspace-mutation-client";
import { command, dockerPath, dockerWorkspaceArgs } from "../src/worker";

const tag = `orbit-app-reader-fixture:${randomUUID()}`;
const parent = `orbit-app-${randomUUID()}`;
const probe = `orbit-app-reader-inspect-${randomUUID()}`;
const root = await fs.realpath(
	await fs.mkdtemp(path.join(os.tmpdir(), "orbit-reader-image-ci-")),
);
const docker = (args: string[], deadline = 8_000) =>
	command(dockerPath, args, deadline);
const createRequests: string[][] = [];
try {
	await docker(
		["build", "--file", "worker/reader/Dockerfile", "--tag", tag, "worker"],
		180_000,
	);
	const description = (
		await docker([
			"image",
			"inspect",
			"--format",
			'{{.Id}} {{index .Config.Labels "org.cybergarage.orbit-app.workspace-reader-standalone"}}',
			tag,
		])
	).trim();
	const image = /^(sha256:[a-f0-9]{64}) 1$/.exec(description)?.[1];
	assert.ok(image, "Expect the pinned standalone reader capability");

	const checked = await docker([
		"run",
		"--rm",
		"--pull=never",
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--name",
		probe,
		"--entrypoint",
		"/usr/local/bin/node",
		image,
		"--input-type=module",
		"-e",
		`
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { createRequire } from "node:module";
		const resolve = createRequire("/opt/worker/workspace-reader.mjs").resolve;
		for (const name of ["fast-glob", "ignore"])
			assert.ok(resolve(name).startsWith("/opt/worker/node_modules/"));
		for (const name of ["@cybergarage/orbit", "better-sqlite3"])
			assert.throws(() => resolve(name), { code: "MODULE_NOT_FOUND" });
		assert.deepEqual(fs.readdirSync("/opt/worker").sort(), ["node_modules", "policy.mjs", "workspace-reader.mjs"]);
		assert.equal(process.getuid?.() === 0, false);
		console.log("isolated dependencies verified");
		`,
	]);
	assert.match(checked, /isolated dependencies verified/);
	await fs.writeFile(
		path.join(root, "note.txt"),
		"alpha synthetic reader\nbeta\n",
	);
	const ports = {
		docker: dockerPath,
		args: (name: string, workspace: string) =>
			dockerWorkspaceArgs(name, workspace, image, true),
		async command(exe: string, args: string[], timeout: number) {
			const output = await command(exe, args, timeout);
			if (args[0] !== "create") return output;
			createRequests.push(args);
			assert.ok(args.includes(image));
			assert.ok(
				args.includes(
					`type=bind,src=${root},dst=/workspace,readonly,bind-recursive=disabled`,
				),
			);
			const [container] = JSON.parse(await docker(["inspect", output.trim()]));
			assert.equal(container.HostConfig.NetworkMode, "none");
			assert.equal(container.HostConfig.ReadonlyRootfs, true);
			assert.deepEqual(
				container.Mounts.map(
					(mount: { Type: string; Destination: string; RW: boolean }) => [
						mount.Type,
						mount.Destination,
						mount.RW,
					],
				),
				[["bind", "/workspace", false]],
			);
			return output;
		},
	};
	async function run(
		name: "read" | "list" | "glob" | "grep",
		target: string,
		input: Record<string, unknown>,
	) {
		const reply = await executeWorkspaceObservation(
			parent,
			root,
			{
				version: 1,
				name,
				effect: "read",
				cwd: "/workspace",
				target,
				input: { path: target, ...input },
			},
			new AbortController().signal,
			ports,
		);
		assert.equal(
			(reply as { isError?: boolean }).isError,
			undefined,
			JSON.stringify(reply),
		);
		return JSON.stringify(reply);
	}
	assert.match(
		await run("read", "/workspace/note.txt", {}),
		/alpha synthetic reader/,
	);
	assert.match(await run("list", "/workspace", {}), /note\.txt/);
	assert.match(
		await run("glob", "/workspace", { pattern: "*.txt" }),
		/note\.txt/,
	);
	assert.match(
		await run("grep", "/workspace", { pattern: "synthetic", glob: "*.txt" }),
		/alpha synthetic reader/,
	);
	assert.equal(createRequests.length, 4);
	const gone = await docker([
		"ps",
		"-a",
		"--filter",
		`label=org.cybergarage.orbit-app.workspace-parent=${parent}`,
		"--format",
		"{{.Names}}",
	]);
	assert.equal(gone.trim(), "", "No disposable reader may remain");
	assert.deepEqual(await fs.readdir(root), ["note.txt"]);
	assert.equal(
		await fs.readFile(path.join(root, "note.txt"), "utf8"),
		"alpha synthetic reader\nbeta\n",
	);
	console.log(
		"Standalone reader verified: no Core/SQLite package, read-only workspace, four tools, and teardown.",
	);
} finally {
	await docker(["rm", "-f", probe]).catch(() => {});
	await docker(["image", "rm", tag]).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
}

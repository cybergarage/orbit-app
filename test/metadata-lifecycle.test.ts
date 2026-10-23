import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ContainerCoreNames } from "../src/core-names";
import { command, dockerPath } from "../src/worker";
import type { MetadataTransport } from "../src/metadata-helper";

async function until(read: () => Promise<boolean>) {
	const end = Date.now() + 5000;
	while (!(await read())) {
		if (Date.now() > end) throw new Error("Synthetic helper fixture stalled");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function fixture(mode: string, extra = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-metadata-life-"));
	const file = path.join(root, "docker.json");
	const script = path.resolve("test/fixtures/metadata-docker.mjs");
	await fs.writeFile(file, JSON.stringify({ mode, ...extra }));
	const read = async () => JSON.parse(await fs.readFile(file, "utf8"));
	const transport: MetadataTransport = {
		command: (args) => command(process.execPath, [script, file, ...args]),
		start: (args) =>
			spawn(process.execPath, [script, file, ...args], {
				stdio: ["pipe", "pipe", "pipe"],
			}),
	};
	const options = { transport, timeoutMs: 150, outputLimit: 512 };
	const core = path.join(root, "projects", crypto.randomUUID(), "core");
	return {
		root,
		core,
		file,
		read,
		transport,
		options,
		async dispose() {
			const state = await read();
			if (state.writerPid) {
				try {
					process.kill(state.writerPid, "SIGKILL");
				} catch {}
			}
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("metadata timeout holds the shared lane and shutdown until the surviving helper is absent", async () => {
	const f = await fixture("timeout", { waitRemove: true });
	try {
		const a = new ContainerCoreNames(f.root, f.options),
			b = new ContainerCoreNames(f.root, f.options);
		const first = assert.rejects(
			a.call(f.core, { command: "create-project" }),
			/timed out/,
		);
		await until(async () => !!(await f.read()).writerPid);
		let closed = false,
			next = false;
		const closing = a.close().then(() => {
			closed = true;
		});
		const queued = b.call(f.core, { command: "create-project" }).then(() => {
			next = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(closed, false);
		assert.equal(next, false);
		assert.equal((await f.read()).creates, 1);
		await assert.rejects(
			a.call(f.core, { command: "create-project" }),
			/closed/,
		);
		await fs.writeFile(`${f.file}.release`, "release");
		await Promise.all([first, closing, queued]);
		assert.equal((await f.read()).writerAliveAtRemove, true);
		assert.equal((await f.read()).creates, 2);
		await assert.rejects(
			fs.access(path.join(f.root, ".metadata-helper.json")),
			{ code: "ENOENT" },
		);
		await b.close();
	} finally {
		await f.dispose();
	}
});

for (const mode of ["output", "exit"]) {
	test(`metadata ${mode} failure stops the independent writer before another request`, async () => {
		const f = await fixture(mode);
		try {
			const client = new ContainerCoreNames(f.root, {
				...f.options,
				timeoutMs: 2000,
			});
			await assert.rejects(
				client.call(f.core, { command: "create-project" }),
				mode === "output" ? /output limit/ : /exit 17/,
			);
			assert.equal((await f.read()).writerAliveAtRemove, true);
			assert.equal((await f.read()).exists, false);
			assert.equal(
				await client.call(f.core, { command: "create-project" }),
				"complete",
			);
			await client.close();
		} finally {
			await f.dispose();
		}
	});
}

test("unconfirmed metadata stop blocks all clients and shutdown until explicit owned recovery", async () => {
	const f = await fixture("timeout", { refuse: true });
	try {
		const client = new ContainerCoreNames(f.root, f.options);
		await assert.rejects(
			client.call(f.core, { command: "create-project" }),
			/profile blocked/,
		);
		const second = new ContainerCoreNames(f.root, f.options);
		await assert.rejects(
			second.call(f.core, { command: "create-project" }),
			/profile blocked/,
		);
		await assert.rejects(client.close(), /profile blocked/);
		assert.equal((await f.read()).creates, 1);
		await fs.access(path.join(f.root, ".metadata-helper.json"));
		const state = await f.read();
		await fs.writeFile(
			f.file,
			JSON.stringify({ ...state, refuse: false, wrongOwner: true }),
		);
		await assert.rejects(
			ContainerCoreNames.recover(f.root, f.options),
			/ownership changed/,
		);
		assert.equal((await f.read()).exists, true);
		await fs.writeFile(f.file, JSON.stringify({ ...state, refuse: false }));
		await ContainerCoreNames.recover(f.root, f.options);
		assert.equal(
			await second.call(f.core, { command: "create-project" }),
			"complete",
		);
		await second.close();
	} finally {
		await f.dispose();
	}
});

test("real Docker helper survives a killed CLI, fences shutdown, and recovers by durable ID in a new process", {
	timeout: 25000,
}, async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-metadata-docker-"),
	);
	const core = path.join(root, "projects", crypto.randomUUID(), "core");
	let id = "",
		ready = false;
	const transport: MetadataTransport = {
		async command(args) {
			if (args[0] === "rm")
				throw new Error("Synthetic unavailable stop transport");
			if (args[0] === "create") {
				args = [
					...args.slice(0, -1),
					"-e",
					"process.stdout.write('ready\\n');setInterval(()=>{},1000)",
				];
				id = (await command(dockerPath, args)).trim();
				return id;
			}
			return command(dockerPath, args);
		},
		start(args) {
			const child = spawn(dockerPath, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdout.on("data", (part) => {
				if (String(part).includes("ready")) ready = true;
			});
			return child;
		},
	};
	try {
		const client = new ContainerCoreNames(root, { transport, timeoutMs: 3000 });
		await assert.rejects(
			client.call(core, { command: "create-project" }),
			/profile blocked/,
		);
		assert.equal(ready, true);
		assert.equal(
			(
				await command(dockerPath, [
					"inspect",
					"--format",
					"{{.State.Running}}",
					id,
				])
			).trim(),
			"true",
		);
		await assert.rejects(client.close(), /profile blocked/);
		const fresh = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {ContainerCoreNames} from './src/core-names.ts'; try { await new ContainerCoreNames(${JSON.stringify(root)}).close(); process.exitCode=1; } catch(error) { if(!String(error).includes('recovery required')) throw error; } try { await new ContainerCoreNames(${JSON.stringify(root)}).call(${JSON.stringify(core)}, {command:'create-project'}); process.exitCode=1; } catch(error) { if(!String(error).includes('recovery required')) throw error; }`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		assert.equal(fresh.status, 0, fresh.stderr);
		const file = path.join(root, ".metadata-helper.json");
		const record = JSON.parse(await fs.readFile(file, "utf8"));
		assert.equal(record.id, id);
		const dead = spawnSync(process.execPath, ["-e", ""]);
		record.ownerPid = dead.pid;
		await fs.writeFile(file, JSON.stringify(record));
		const recovery = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/recover-metadata.ts", root],
			{ encoding: "utf8", timeout: 10000 },
		);
		assert.equal(recovery.status, 0, recovery.stderr);
		assert.equal(
			await command(dockerPath, [
				"ps",
				"-a",
				"--no-trunc",
				"--filter",
				`id=${id}`,
				"--format",
				"{{.ID}}",
			]).then((s) => s.trim()),
			"",
		);
		await assert.rejects(fs.access(file), { code: "ENOENT" });
	} finally {
		if (id) await command(dockerPath, ["rm", "-f", id]).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

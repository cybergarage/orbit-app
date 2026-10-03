import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Supervisor } from "../src/supervisor";
import { command, dockerPath, dockerArgs, image } from "../src/worker";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-recovery-"));
const sup = new Supervisor(root, () => {});
await sup.init();
const p = await sup.store.createProject("Crash recovery"),
	s = await sup.store.createSession(p.id);
const name = `orbit-app-${randomUUID()}`;
const args = dockerArgs(name, sup.store.workspace(p.id), sup.store.core(p.id));
args.splice(1, 0, "-d");
args.splice(args.indexOf(image), 0, "--entrypoint", "node");
args.push("-e", "setInterval(()=>{},1000)");
await command(dockerPath, args);
s.status = "running";
sup.store.state.active = {
	projectId: p.id,
	sessionId: s.id,
	containerName: name,
};
await sup.store.save();
const restored = new Supervisor(root, () => {});
await restored.init();
assert.equal(restored.store.state.active, undefined);
assert.equal(restored.store.session(p.id, s.id).status, "interrupted");
assert.equal(
	(
		await command(dockerPath, [
			"ps",
			"-a",
			"--filter",
			`name=^/${name}$`,
			"--format",
			"{{.Names}}",
		])
	).trim(),
	"",
);
console.log("Persisted orphan ownership and container cleanup verified");

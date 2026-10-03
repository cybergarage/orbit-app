import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Supervisor } from "../src/supervisor";
import { command, dockerPath, dockerArgs, image } from "../src/worker";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-live-"));
const events: any[] = [];
let supervisor: Supervisor;
supervisor = new Supervisor(root, (state) => {
	const a = state.active;
	if (!a) return;
	const session = state.projects
		.find((p) => p.id === a.projectId)
		?.sessions.find((s) => s.id === a.sessionId);
	const e = session?.events.at(-1);
	if (e && events.at(-1)?.id !== e.id) {
		events.push(e);
		if (["approval", "error", "result"].includes(e.type))
			console.log(
				e.type,
				e.type === "approval"
					? JSON.stringify(e.data.preview)
					: e.type === "error"
						? e.data
						: "",
			);
	}
	if (e?.type === "approval") {
		void supervisor
			.dispatch("approve", { id: e.data.id, approve: true })
			.catch(() => {});
	}
});
await supervisor.init();
const p = await supervisor.store.createProject("Harmless live fixture"),
	s = await supervisor.store.createSession(p.id);
const workspace = supervisor.store.workspace(p.id);
await fs.writeFile(
	path.join(workspace, "sum.cjs"),
	"module.exports = (a, b) => a - b;\n",
);
await fs.writeFile(
	path.join(workspace, "test.cjs"),
	"const assert=require('node:assert/strict');const sum=require('./sum.cjs');assert.equal(sum(2,3),5);console.log('fixture tests passed');\n",
);
const prompt =
	"In /workspace, read sum.cjs and test.cjs. Fix sum.cjs so sum adds two numbers. Use the edit tool or write tool to modify the file. Then run node test.cjs using bash. Report the test result. Do not access anything outside /workspace.";
await supervisor.submit({
	projectId: p.id,
	sessionId: s.id,
	prompt,
	model: "gemma4:12b",
	requestId: randomUUID(),
});
const deadline = Date.now() + 250000;
while (supervisor.worker && Date.now() < deadline)
	await new Promise((r) => setTimeout(r, 500));
assert.ok(!supervisor.worker, "Worker finished in budget");
assert.equal(s.status, "completed");
const code = await fs.readFile(path.join(workspace, "sum.cjs"), "utf8");
assert.ok(code.includes("+"));
assert.ok(events.some((e) => e.type === "approval"));
assert.ok(
	events.some(
		(e) =>
			e.type === "agent-event" &&
			e.data.type === "tool-completed" &&
			e.data.toolCall.name === "bash",
	),
);
const args = dockerArgs(
	`orbit-app-isolation-${randomUUID()}`,
	workspace,
	supervisor.store.core(p.id),
);
const index = args.indexOf(image);
args.splice(index, 0, "--entrypoint", "node");
args.push(
	"-e",
	`const fs=require('fs');const net=require('net');let bad=false;for(const p of ['/var/run/docker.sock','/Users/skonno/.ssh','/state/../other-project'])if(fs.existsSync(p))bad=true;try{fs.writeFileSync('/opt/escape','x');bad=true}catch{}const s=net.connect(11434,'192.168.65.254');s.on('connect',()=>process.exit(1));s.on('error',()=>{console.log('isolation checks passed');process.exit(bad?1:0)});setTimeout(()=>process.exit(bad?1:0),3000);`,
);
const isolation = await command(dockerPath, args, 10000);
assert.ok(isolation.includes("isolation checks passed"));
const restored = new Supervisor(root, () => {});
await restored.init();
assert.equal(restored.store.session(p.id, s.id).answer, s.answer);
await restored.submit({
	projectId: p.id,
	sessionId: s.id,
	prompt:
		"Without using tools, name the exact success message printed by test.cjs in the preceding turn.",
	model: "gemma4:12b",
	requestId: randomUUID(),
});
const resumedDeadline = Date.now() + 240000;
while (restored.worker && Date.now() < resumedDeadline)
	await new Promise((r) => setTimeout(r, 500));
const resumed = restored.store.session(p.id, s.id);
assert.equal(resumed.status, "completed");
assert.match(resumed.answer ?? "", /fixture tests passed/);
console.log("Core session resume and model context verified");
await restored.close();

assert.ok((await fs.readdir(supervisor.store.core(p.id))).includes("sessions"));
await fs.mkdir("test-results", { recursive: true });
await fs.writeFile(
	"test-results/live.json",
	JSON.stringify(
		{
			root,
			model: "gemma4:12b",
			status: s.status,
			answer: s.answer,
			events: s.events,
			isolation,
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify({ root, status: s.status, answer: s.answer, isolation }),
);
await supervisor.close();

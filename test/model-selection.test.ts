import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import type { CoreNames } from "../src/core-names";

function names(): CoreNames {
	const projects = new Map<string, string>();
	const sessions = new Map<string, string>();
	return {
		async call(_core, request: any) {
			if (request.command === "create-project") {
				projects.set(request.projectId, request.name);
				return { name: request.name, revision: 0 };
			}
			if (request.command === "read-project")
				return { name: projects.get(request.projectId), revision: 0 };
			if (request.command === "create-session") {
				sessions.set(request.sessionId, request.name);
				return { name: request.name, revision: 0 };
			}
			if (request.command === "rename-session") {
				sessions.set(request.sessionId, request.name);
				return { name: request.name, revision: 1 };
			}
			if (request.command === "read-sessions")
				return request.sessionIds.map((id: string) => ({
					id,
					name: sessions.get(id),
					revision: 1,
				}));
			throw new Error(`Unexpected metadata request: ${request.command}`);
		},
	};
}
test("default model survives restart and applies only to new conversations", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-default-model-"));
	const coreNames = names();
	const store = new Store(root, coreNames);
	try {
		await store.init();
		const project = {
			id: randomUUID(),
			name: "Project",
			nameRevision: 1,
			sessions: [],
		};
		store.state.projects.push(project);
		const first = await store.createSession(project.id);
		first.model = "old";
		store.state.defaultModel = { model: "new", provider: "ollama" };
		const second = await store.createSession(project.id);
		assert.equal(first.model, "old");
		assert.equal(second.model, "new");
		await store.save();
		const restored = new Store(root, coreNames);
		await restored.init();
		assert.deepEqual(restored.state.defaultModel, {
			model: "new",
			provider: "ollama",
		});
		assert.equal(restored.session(project.id, first.id).model, "old");
		assert.equal((await restored.createSession(project.id)).model, "new");
		await restored.close();
		const preferences = JSON.parse(
			await fs.readFile(path.join(root, "settings.json"), "utf8"),
		);
		assert.equal(preferences.defaultModel.model, "new");
		const saved = JSON.parse(await fs.readFile(Store.stateFile(root), "utf8"));
		assert.equal(saved.defaultModel, undefined);
	} finally {
		await store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("invalid saved provider is rejected without changing settings", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-invalid-default-"),
	);
	const file = path.join(root, "settings.json");
	const original = JSON.stringify({
		defaultModel: { provider: "apple", model: "system" },
	});
	await fs.writeFile(file, original);
	try {
		await assert.rejects(
			new Store(root, names()).init(),
			/Invalid saved default/,
		);
		assert.equal(await fs.readFile(file, "utf8"), original);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Supervisor rejects unavailable models, preserves active turns and isolates conversation selections", async () => {
	const { Supervisor } = await import("../src/supervisor");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-model-command-"));
	const supervisor = new Supervisor(root, () => {});
	await supervisor.store.init();
	const projectId = randomUUID(),
		a = randomUUID(),
		b = randomUUID();
	supervisor.store.state.projects = [
		{
			id: projectId,
			name: "Project",
			nameRevision: 1,
			sessions: [
				{
					id: a,
					name: "A",
					model: "old",
					events: [
						{
							type: "submission",
							at: new Date().toISOString(),
							data: { model: "old" },
						},
					],
					status: "running",
				},
				{ id: b, name: "B", model: "old", events: [], status: "idle" },
			],
		},
	];
	supervisor.health = async () => ({
		docker: true,
		ollama: true,
		image: true,
		models: ["old", "new"],
		detail: [],
	});
	try {
		await assert.rejects(
			supervisor.dispatch("select-model", {
				projectId,
				sessionId: a,
				model: "missing",
			}),
			/tool-capable/,
		);
		assert.equal(supervisor.store.session(projectId, a).model, "old");
		await supervisor.dispatch("select-model", {
			projectId,
			sessionId: a,
			model: "new",
		});
		assert.equal(supervisor.store.session(projectId, a).model, "new");
		assert.equal(
			supervisor.store.session(projectId, a).events[0].data.model,
			"old",
		);
		assert.equal(supervisor.store.session(projectId, b).model, "old");
		await supervisor.dispatch("default-model", {
			provider: "ollama",
			model: "new",
		});
		await assert.rejects(
			supervisor.dispatch("default-model", {
				provider: "ollama",
				model: "missing",
			}),
			/tool-capable/,
		);
		assert.equal(supervisor.store.state.defaultModel?.model, "new");
		assert.equal(supervisor.store.session(projectId, b).model, "old");
	} finally {
		await supervisor.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

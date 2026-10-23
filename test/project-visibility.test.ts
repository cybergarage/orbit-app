import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "../src/supervisor";
import { ContainerCoreNames } from "../src/core-names";

test("new Project registry/catalog visibility survives background idle reconciliation and immediate configuration", {
	timeout: 120000,
}, async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-project-visibility-"),
	);
	const sup = new Supervisor(
		root,
		() => {},
		undefined,
		async () => {
			throw new Error("No title inference");
		},
		{ extract: async () => ({ text: '{"candidates":[]}' }) },
	);
	const reader = new ContainerCoreNames(root);
	let stage = "init",
		id = "";
	const tick = setInterval(() => {
		void sup.tick().catch(() => {});
	}, 50);
	try {
		await sup.init();
		for (let index = 0; index < 12; index++) {
			stage = "create-project";
			const p = await sup.dispatch("create-project", {
				name: `Visibility ${index}`,
			});
			id = p.id;
			assert.ok(sup.store.project(id));
			stage = "catalog visibility after create";
			assert.equal(
				(
					await reader.call(path.join(root, "catalog"), {
						command: "catalog-query",
						query: { kind: "project", id },
					})
				).id,
				id,
			);
			stage = "create-session";
			const chat = await sup.dispatch("create-session", { projectId: id });
			stage = "rename-session";
			await sup.dispatch("rename-session", {
				projectId: id,
				sessionId: chat.id,
				name: `Visibility chat ${index}`,
				expectedRevision: chat.nameRevision,
				operationId: crypto.randomUUID(),
			});
			stage = "configure";
			await sup.dispatch("knowledge-control", {
				projectId: id,
				enabled: false,
				limits: { maxInputTokens: 6144, maxOutputTokens: 1024, maxCalls: 1 },
			});
			stage = "status";
			assert.equal(
				(await sup.knowledge.status(id)).config?.maxInputTokens,
				6144,
			);
		}
	} catch (error) {
		throw new Error(`Project visibility ${stage} (${id}): ${String(error)}`, {
			cause: error,
		});
	} finally {
		clearInterval(tick);
		await reader.close();
		await sup.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "../src/supervisor";
import { ContainerCoreNames } from "../src/core-names";

test("new Project registry/catalog visibility survives background idle reconciliation and immediate configuration", {
	timeout: 120000,
}, async (t) => {
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
	const started = performance.now();
	const stageTimes: string[] = [];
	const mark = (next: string) => {
		stage = next;
		const entry = `${Math.round(performance.now() - started)}ms ${id} ${next}`;
		stageTimes.push(entry);
		console.log(`Project visibility: ${entry}`);
	};
	let stage = "init",
		id = "";
	const tick = setInterval(() => {
		void sup.tick().catch(() => {});
	}, 50);
	try {
		await sup.init();
		for (let index = 0; index < 12; index++) {
			t.signal.throwIfAborted();
			mark("create-project");
			const p = await sup.dispatch("create-project", {
				name: `Visibility ${index}`,
			});
			id = p.id;
			assert.ok(sup.store.project(id));
			// Configuration itself resolves each Project through the catalog below.
			// Sample an additional independent reader at both ends of the sequence.
			if (index === 0 || index === 11) {
				mark("catalog visibility after create");
				assert.equal(
					(
						await reader.call(path.join(root, "catalog"), {
							command: "catalog-query",
							query: { kind: "project", id },
						})
					).id,
					id,
				);
			}
			// Exercise the complete chat lifecycle on the first and last Project.
			// Middle iterations target immediate Project→configuration visibility;
			// duplicating chat creation there adds unrelated container admissions.
			if (index === 0 || index === 11) {
				mark("create-session");
				const chat = await sup.dispatch("create-session", { projectId: id });
				mark("rename-session");
				await sup.dispatch("rename-session", {
					projectId: id,
					sessionId: chat.id,
					name: `Visibility chat ${index}`,
					expectedRevision: chat.nameRevision,
					operationId: crypto.randomUUID(),
				});
			}
			mark("configure");
			await sup.dispatch("knowledge-control", {
				projectId: id,
				enabled: false,
				limits: { maxInputTokens: 6144, maxOutputTokens: 1024, maxCalls: 1 },
			});
			mark("status");
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
		t.diagnostic(stageTimes.join("\n"));
		clearInterval(tick);
		await reader.close();
		await sup.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

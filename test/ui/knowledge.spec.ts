import {
	test,
	expect,
	_electron as electron,
	type Page,
	type ElectronApplication,
} from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function knowledgeFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-knowledge-ui-")),
		entry = path.join(root, "main.cjs");
	await build({
		entryPoints: ["test/fixtures/knowledge-main.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile: entry,
		external: ["electron"],
		plugins: [
			{
				name: "local-core",
				setup(builder) {
					builder.onResolve({ filter: /^@cybergarage\/orbit$/ }, () => ({
						path: path.resolve("node_modules/@cybergarage/orbit/dist/index.js"),
						external: true,
					}));
				},
			},
		],
	});
	const launch = () =>
		electron.launch({
			timeout: 20000,
			args: process.env.CI ? [entry, "--no-sandbox"] : [entry],
			env: {
				...process.env,
				ORBIT_KNOWLEDGE_ROOT: root,
				ORBIT_KNOWLEDGE_DIST: path.resolve("dist"),
			},
		});
	return { root, launch };
}
async function openKnowledge(page: Page) {
	await page.getByText("Project knowledge", { exact: true }).click();
	await expect(page.locator(".knowledge-panel > fieldset")).toHaveJSProperty(
		"disabled",
		true,
	);
	await expect(page.locator(".knowledge-panel > fieldset")).toHaveJSProperty(
		"disabled",
		false,
		{
			timeout: 30000,
		},
	);
	await expect(page.locator(".knowledge-panel [role=alert]")).toHaveCount(0);
}
async function knowledgeAction(
	page: Page,
	name: string,
	whileBusy?: () => Promise<void>,
) {
	const started = Date.now();
	await page.getByRole("button", { name, exact: true }).click();
	const fieldset = page.locator(".knowledge-panel > fieldset");
	await expect(fieldset).toHaveJSProperty("disabled", true);
	if (whileBusy) await whileBusy();
	// This budget covers the real serialized Docker mutation and its status IPC.
	await expect(fieldset).toHaveJSProperty("disabled", false, {
		timeout: 30000,
	});
	await expect(page.locator(".knowledge-panel [role=alert]")).toHaveCount(0);
	console.log(
		"Knowledge UI action",
		JSON.stringify({
			name,
			started,
			completed: Date.now(),
			ms: Date.now() - started,
		}),
	);
}
async function reportKnowledgeFailure(
	app: ElectronApplication,
	page: Page,
	root: string,
) {
	console.log("Synthetic failure profile retained in place", root);
	console.log(
		"Synthetic IPC trace",
		JSON.stringify(
			await app
				.evaluate(() => (globalThis as any).knowledgeControl.ipcTrace)
				.catch(() => []),
		),
	);
	console.log(
		"Synthetic metadata failure trace",
		JSON.stringify(
			await app
				.evaluate(() => (globalThis as any).knowledgeControl.metadataTrace)
				.catch(() => []),
		),
	);
	console.log(
		"Synthetic UI state",
		JSON.stringify(
			await page
				.locator(".knowledge-panel")
				.evaluate((element) => ({
					disabled: element.querySelector("fieldset")?.disabled,
					buttons: Array.from(element.querySelectorAll("button")).map((b) => ({
						text: b.textContent,
						disabled: b.disabled,
					})),
					inputs: Array.from(element.querySelectorAll("input")).map((i) => ({
						value: i.value,
						disabled: i.disabled,
					})),
				}))
				.catch(() => null),
		),
	);
}

test("Project knowledge UI learns A, reuses it in B, edits, stops and deletes through real IPC", async () => {
	test.setTimeout(180000);
	const { root, launch } = await knowledgeFixture();
	let app = await launch();
	let failed = false;
	let page = await app.firstWindow();
	try {
		const ids = await page.evaluate(async () => {
			const p = await window.orbit.call("create-project", {
				name: "Knowledge UI",
			});
			const a = await window.orbit.call("create-session", { projectId: p.id });
			const b = await window.orbit.call("create-session", { projectId: p.id });
			for (const [session, name] of [
				[a, "Decision A"],
				[b, "Question B"],
			] as const)
				await window.orbit.call("rename-session", {
					projectId: p.id,
					sessionId: session.id,
					name,
					expectedRevision: session.nameRevision ?? 0,
					operationId: crypto.randomUUID(),
				});
			return { p: p.id, a: a.id, b: b.id };
		});
		await page.getByRole("button", { name: "Decision A", exact: true }).click();
		await page
			.getByPlaceholder("Ask anything…")
			.fill("Use PostgreSQL for the catalog.");
		await page.getByRole("button", { name: "Run task ↗", exact: true }).click();
		await expect(page.getByText("Acknowledged", { exact: true })).toBeVisible({
			timeout: 60000,
		});
		const pageClosed = page.waitForEvent("close");
		await app.evaluate(({ BrowserWindow }) => {
			for (const window of BrowserWindow.getAllWindows()) window.close();
		});
		await pageClosed;
		await expect
			.poll(() =>
				app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
				),
			)
			.toBe(0);
		await app.evaluate(() =>
			(globalThis as any).knowledgeControl.releaseLearning(),
		);
		await expect
			.poll(
				async () =>
					app.evaluate(
						async (_electron, projectId) =>
							(
								await (
									globalThis as any
								).knowledgeControl.supervisor.knowledge.status(projectId)
							).entries.length,
						ids.p,
					),
				{ timeout: 60000 },
			)
			.toBe(1);
		const reopened = app.waitForEvent("window");
		await app.evaluate(({ app }) => {
			app.emit("activate");
		});
		page = await reopened;
		await expect
			.poll(
				async () =>
					page.evaluate(
						async (projectId) =>
							(await window.orbit.call("knowledge-status", { projectId }))
								.entries.length,
						ids.p,
					),
				{ timeout: 60000 },
			)
			.toBe(1);
		await page.getByRole("button", { name: "Decision A", exact: true }).click();
		await openKnowledge(page);
		await expect(page.locator(".knowledge-panel article")).toHaveCount(1);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByRole("button", { name: "Question B", exact: true }).click();
		await page
			.getByPlaceholder("Ask anything…")
			.fill("Which database stores the catalog?");
		await page.getByRole("button", { name: "Run task ↗", exact: true }).click();
		await expect(
			page.getByText("PostgreSQL selected", { exact: true }),
		).toBeVisible({ timeout: 60000 });
		await openKnowledge(page);
		await expect(page.locator(".knowledge-panel article")).toHaveCount(1);

		await app.evaluate(() =>
			(globalThis as any).knowledgeControl.holdNextControlReply(),
		);
		await knowledgeAction(page, "Stop learning", async () => {
			try {
				await expect
					.poll(
						() =>
							app.evaluate(
								() =>
									(globalThis as any).knowledgeControl.ipcTrace
										.filter((t: any) => t.command === "knowledge-control")
										.at(-1)?.dispatched,
							),
						{ timeout: 30000 },
					)
					.toEqual(expect.any(Number));
				const saved = await page.evaluate(
					async (projectId) =>
						(await window.orbit.call("knowledge-status", { projectId })).config,
					ids.p,
				);
				expect(saved.enabled).toBe(false);
				await expect(
					page.getByRole("button", { name: "Resume learning", exact: true }),
				).toHaveCount(0);
				console.log(
					"Stop persisted before response release",
					JSON.stringify(saved),
				);
			} finally {
				await app.evaluate(() =>
					(globalThis as any).knowledgeControl.releaseControlReply(),
				);
			}
		});
		await expect(
			page.getByRole("button", { name: "Resume learning", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Edit or correct", exact: true })
			.click();
		await page
			.getByLabel("Knowledge correction")
			.fill("Use PostgreSQL with verified migrations.");
		await knowledgeAction(page, "Save correction");
		await expect(
			page.getByText("Use PostgreSQL with verified migrations.", {
				exact: true,
			}),
		).toBeVisible();
		await knowledgeAction(page, "Delete knowledge");
		await expect(page.locator(".knowledge-panel article strong")).toContainText(
			"deleted",
		);
		await knowledgeAction(page, "Resume learning");
		const status = await page.evaluate(
			async (projectId) => window.orbit.call("knowledge-status", { projectId }),
			ids.p,
		);
		expect(status.entries[0].retired).toBe(true);
		expect(status.config.enabled).toBe(true);
		await page.screenshot({
			path: "/tmp/orbit-knowledge-app-ui.png",
			fullPage: true,
		});
	} catch (error) {
		failed = true;
		await reportKnowledgeFailure(app, page, root);
		throw error;
	} finally {
		await app.close();
		if (!failed) await fs.rm(root, { recursive: true, force: true });
	}
});

test("Project budget UI restores saved limits through refresh, partial edits, restart and Project switching", async () => {
	test.setTimeout(180000);
	const { root, launch } = await knowledgeFixture();
	let app = await launch();
	let page = await app.firstWindow();
	let failed = false;
	try {
		const ids = await page.evaluate(async () => {
			const result: string[] = [];
			for (const [name, input, output, calls] of [
				["Budget A", 8192, 2048, 2],
				["Budget B", 6144, 1024, 1],
			] as const) {
				const p = await window.orbit.call("create-project", { name });
				const chat = await window.orbit.call("create-session", {
					projectId: p.id,
				});
				await window.orbit.call("rename-session", {
					projectId: p.id,
					sessionId: chat.id,
					name,
					expectedRevision: chat.nameRevision ?? 0,
					operationId: crypto.randomUUID(),
				});
				await window.orbit.call("knowledge-control", {
					projectId: p.id,
					enabled: false,
					limits: {
						maxInputTokens: input,
						maxOutputTokens: output,
						maxCalls: calls,
					},
				});
				result.push(p.id);
			}
			return result;
		});
		await page.getByRole("button", { name: "Budget A", exact: true }).click();
		await openKnowledge(page);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"8192",
		);
		await page.getByLabel("Lifetime input-token limit").fill("12288");
		const before = await app.evaluate(
			() =>
				(globalThis as any).knowledgeControl.ipcTrace.filter(
					(t: any) => t.command === "knowledge-status",
				).length,
		);
		await knowledgeAction(page, "Refresh knowledge");
		const after = await app.evaluate(
			() =>
				(globalThis as any).knowledgeControl.ipcTrace.filter(
					(t: any) => t.command === "knowledge-status",
				).length,
		);
		expect(after - before).toBe(1);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"12288",
		);
		await knowledgeAction(page, "Apply token limit");
		const read = () =>
			page.evaluate(
				async (projectId) =>
					(await window.orbit.call("knowledge-status", { projectId })).config,
				ids[0],
			);
		expect(await read()).toMatchObject({
			maxInputTokens: 12288,
			maxOutputTokens: 2048,
			maxCalls: 2,
			enabled: false,
		});
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByRole("button", { name: "Budget A", exact: true }).click();
		await openKnowledge(page);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"12288",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"2048",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("2");
		await page.getByLabel("Lifetime input-token limit").fill("14336");
		await knowledgeAction(page, "Apply token limit");
		expect(await read()).toMatchObject({
			maxInputTokens: 14336,
			maxOutputTokens: 2048,
			maxCalls: 2,
			enabled: false,
		});
		await page.getByRole("button", { name: "Budget B", exact: true }).click();
		await openKnowledge(page);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"6144",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"1024",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("1");
		await page.getByRole("button", { name: "Budget A", exact: true }).click();
		await openKnowledge(page);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"14336",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"2048",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("2");
		console.log(
			"Budget IPC trace",
			JSON.stringify(
				await app.evaluate(() => (globalThis as any).knowledgeControl.ipcTrace),
			),
		);
	} catch (error) {
		failed = true;
		await reportKnowledgeFailure(app, page, root);
		throw error;
	} finally {
		await app.close();
		if (!failed) await fs.rm(root, { recursive: true, force: true });
	}
});

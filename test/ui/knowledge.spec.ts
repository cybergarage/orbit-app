import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Project knowledge UI learns A, reuses it in B, edits, stops and deletes through real IPC", async () => {
	test.setTimeout(180000);
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
			args: [entry],
			env: {
				...process.env,
				ORBIT_KNOWLEDGE_ROOT: root,
				ORBIT_KNOWLEDGE_DIST: path.resolve("dist"),
			},
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
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
		await page.getByText("Project knowledge", { exact: true }).click();
		await expect(page.locator(".knowledge-panel article")).toHaveCount(1);
		await page.getByLabel("Lifetime input-token limit").fill("8192");
		await page.getByLabel("Lifetime output-token limit").fill("2048");
		await page.getByLabel("Lifetime call limit").fill("2");
		await page
			.getByRole("button", { name: "Apply token limit", exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(
					async (id) =>
						(await window.orbit.call("knowledge-status", { projectId: id }))
							.config,
					ids.p,
				),
			)
			.toMatchObject({
				maxInputTokens: 8192,
				maxOutputTokens: 2048,
				maxCalls: 2,
			});
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
		await page.getByText("Project knowledge", { exact: true }).click();
		await expect(page.locator(".knowledge-panel article")).toHaveCount(1);
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"8192",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"2048",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("2");
		await page.getByLabel("Lifetime input-token limit").fill("12288");
		await page
			.getByRole("button", { name: "Refresh knowledge", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Refresh knowledge", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Refresh knowledge", exact: true }),
		).toBeEnabled();
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"12288",
		);
		await page
			.getByRole("button", { name: "Apply token limit", exact: true })
			.click();
		const apply = page.getByRole("button", {
			name: "Apply token limit",
			exact: true,
		});
		await expect(apply).toBeDisabled();
		// Configure awaits real source cancellation, catalog mutation and status refresh.
		await expect(apply).toBeEnabled({ timeout: 30000 });
		const applied = await page.evaluate(
			async (id) =>
				(await window.orbit.call("knowledge-status", { projectId: id })).config,
			ids.p,
		);
		const requests = await app.evaluate(
			() => (globalThis as any).knowledgeControl.limitRequests,
		);
		console.log("Completed limit requests", JSON.stringify(requests));
		expect(applied).toMatchObject({
			maxInputTokens: 12288,
			maxOutputTokens: 2048,
			maxCalls: 2,
		});

		await page
			.getByRole("button", { name: "Stop learning", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Resume learning", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Edit or correct", exact: true })
			.click();
		await page
			.getByLabel("Knowledge correction")
			.fill("Use PostgreSQL with verified migrations.");
		await page
			.getByRole("button", { name: "Save correction", exact: true })
			.click();
		await expect(
			page.getByText("Use PostgreSQL with verified migrations.", {
				exact: true,
			}),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Delete knowledge", exact: true })
			.click();
		await expect(page.locator(".knowledge-panel article strong")).toContainText(
			"deleted",
		);
		await page
			.getByRole("button", { name: "Resume learning", exact: true })
			.click();
		const status = await page.evaluate(
			async (projectId) => window.orbit.call("knowledge-status", { projectId }),
			ids.p,
		);
		expect(status.entries[0].retired).toBe(true);
		await page.evaluate(async () => {
			let stage = "create-project";
			try {
				const other = await window.orbit.call("create-project", {
					name: "Other limits",
				});
				stage = "create-session";
				const chat = await window.orbit.call("create-session", {
					projectId: other.id,
				});
				stage = "rename-session";
				await window.orbit.call("rename-session", {
					projectId: other.id,
					sessionId: chat.id,
					name: "Other limits chat",
					expectedRevision: chat.nameRevision ?? 0,
					operationId: crypto.randomUUID(),
				});
				stage = "configure-other";
				await window.orbit.call("knowledge-control", {
					projectId: other.id,
					enabled: false,
					limits: { maxInputTokens: 6144, maxOutputTokens: 1024, maxCalls: 1 },
				});
			} catch (error) {
				throw new Error(`Other Project ${stage}: ${String(error)}`);
			}
		});
		await page
			.getByRole("button", { name: "Other limits chat", exact: true })
			.click();
		await page.getByText("Project knowledge", { exact: true }).click();
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"6144",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"1024",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("1");
		await page.getByRole("button", { name: "Question B", exact: true }).click();
		await page.getByText("Project knowledge", { exact: true }).click();
		await expect(page.getByLabel("Lifetime input-token limit")).toHaveValue(
			"12288",
		);
		await expect(page.getByLabel("Lifetime output-token limit")).toHaveValue(
			"2048",
		);
		await expect(page.getByLabel("Lifetime call limit")).toHaveValue("2");
		await page.screenshot({
			path: "/tmp/orbit-knowledge-app-ui.png",
			fullPage: true,
		});
	} catch (error) {
		console.log(
			"Synthetic metadata failure trace",
			JSON.stringify(
				await app
					.evaluate(() => (globalThis as any).knowledgeControl.metadataTrace)
					.catch(() => []),
			),
		);
		throw error;
	} finally {
		await app.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

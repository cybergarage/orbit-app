import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("real Supervisor acceptance IPC reorders both groups before Worker completion and survives restart", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-order-ui-"));
	const entry = path.join(root, "main.cjs");
	await build({
		entryPoints: ["test/fixtures/order-main.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
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
		outfile: entry,
	});
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [entry, "--no-sandbox"] : [entry],
			env: {
				...process.env,
				ORBIT_ORDER_ROOT: root,
				ORBIT_ORDER_DIST: path.resolve("dist"),
			},
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const rows = () =>
			page
				.locator("aside .row > button:first-child")
				.filter({ hasText: /^(Project|Chats) [12]$/ });
		await expect(rows()).toHaveText([
			"Project 1",
			"Project 2",
			"Chats 1",
			"Chats 2",
		]);
		for (const group of ["Project", "Chats"]) {
			await page
				.getByRole("button", { name: `${group} 2`, exact: true })
				.click();
			await page.locator("textarea").first().fill("Typing does not reorder");
			const before = await rows().allTextContents();
			expect(before.indexOf(`${group} 1`)).toBeLessThan(
				before.indexOf(`${group} 2`),
			);
			// Retain the IPC result without awaiting it while health is held.
			const submission = await page.evaluateHandle(
				(label) => ({
					outcome: window.orbit
						.call("snapshot")
						.then((s) => {
							const p = s.projects.find(
								(p: { name: string }) => p.name === label,
							);
							return window.orbit.call("submit", {
								projectId: p.id,
								sessionId: p.sessions[1].id,
								prompt: "Fixture task",
								model: "fixture",
								requestId: crypto.randomUUID(),
							});
						})
						.then(
							(result) => ({ result }),
							(error) => ({ error: String(error) }),
						),
				}),
				group,
			);
			await expect
				.poll(async () =>
					(await rows().allTextContents()).indexOf(`${group} 2`),
				)
				.toBe(group === "Project" ? 0 : 2);
			expect(
				await app.evaluate(() => (globalThis as any).orderControl.starts()),
			).toBe(group === "Project" ? 0 : 1);
			await expect
				.poll(() =>
					app.evaluate(() => (globalThis as any).orderControl.healthReady()),
				)
				.toBe(true);
			await app.evaluate(() => (globalThis as any).orderControl.release());
			expect(await submission.evaluate(({ outcome }) => outcome)).toEqual({
				result: { accepted: true },
			});
			await submission.dispose();
			await expect
				.poll(() =>
					app.evaluate(() => (globalThis as any).orderControl.starts()),
				)
				.toBe(group === "Project" ? 1 : 2);
			await app.evaluate(() => (globalThis as any).orderControl.finish());
			// An inactive snapshot precedes the final save and admission release.
			await expect
				.poll(() =>
					app.evaluate(() => (globalThis as any).orderControl.hasWorker()),
				)
				.toBe(false);
			expect(
				await page.evaluate(
					async () => (await window.orbit.call("snapshot")).active,
				),
			).toBeUndefined();
			await expect(rows()).toHaveText(
				group === "Project"
					? ["Project 2", "Project 1", "Chats 1", "Chats 2"]
					: ["Project 2", "Project 1", "Chats 2", "Chats 1"],
			);
		}
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await expect(rows()).toHaveText([
			"Project 2",
			"Project 1",
			"Chats 2",
			"Chats 1",
		]);
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

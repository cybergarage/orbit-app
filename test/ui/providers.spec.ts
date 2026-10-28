import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("combined provider/model picker saves atomic pairs, isolates running workers, restores defaults and shows listing errors", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-provider-ui-"));
	const entry = path.join(root, "main.cjs");
	await build({
		entryPoints: ["test/fixtures/providers-main.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["electron"],
		plugins: [
			{
				name: "core",
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
			timeout: 15000,
			args: [entry],
			env: {
				...process.env,
				ORBIT_PROVIDER_ROOT: root,
				ORBIT_PROVIDER_DIST: path.resolve("dist"),
			},
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		page.setDefaultTimeout(15000);
		console.log("Provider UI: window ready");
		await page
			.getByRole("button", { name: "Project Provider fixture", exact: true })
			.click();
		await page.getByRole("button", { name: "First chat", exact: true }).click();
		const ids = await page.evaluate(async () => {
			const state = await window.orbit.call("snapshot");
			return {
				projectId: state.projects[0].id,
				sessionId: state.projects[0].sessions[0].id,
			};
		});
		const saved = () =>
			page.evaluate(
				async (ids) =>
					(await window.orbit.call("snapshot")).projects
						.find((p: any) => p.id === ids.projectId)
						.sessions.find((s: any) => s.id === ids.sessionId),
				ids,
			);
		const trigger = page.getByRole("button", { name: "Model", exact: true });
		const pop = page.getByRole("dialog", { name: "Model", exact: true });
		await trigger.click();
		await expect(pop.getByRole("button", { name: /OpenAI/ })).toBeVisible();
		const anchor = await trigger.boundingBox(),
			panel = await pop.boundingBox();
		if (!panel || !anchor) throw new Error("Missing picker geometry");
		expect(panel.y + panel.height).toBeLessThanOrEqual(anchor.y + 1);
		await page.screenshot({ path: "test-results/provider-app-open.png" });
		expect((await saved()).provider).toBe("ollama");
		await expect(pop.locator(".provider-option")).toHaveCount(0);
		await expect(pop.locator(".model-option")).toHaveCount(3);
		await expect(pop.getByRole("button")).toHaveCount(3);
		await page.keyboard.press("ArrowDown");
		await expect(pop.locator(".model-option").first()).toBeFocused();
		await page.keyboard.press("End");
		await expect(pop.locator(".model-option").last()).toBeFocused();
		await page.keyboard.press("Home");
		await expect(pop.locator(".model-option").first()).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(pop.locator(".model-option")).toHaveCount(3);
		await page.getByLabel("Task", { exact: true }).click();
		await expect(pop).toHaveCount(0);
		expect((await saved()).provider).toBe("ollama");
		await trigger.click();
		await pop.getByRole("button", { name: /OpenAI \/ gpt-4o/ }).click();
		await expect(trigger).toContainText("gpt-4o");
		await expect(trigger).toBeFocused();
		expect((await saved()).provider).toBe("openai");
		await page.getByLabel("Task", { exact: true }).fill("First mocked turn");
		await page.getByRole("button", { name: /Run task/ }).click();
		await expect
			.poll(() =>
				app.evaluate(() => (globalThis as any).providerControl.configs.length),
			)
			.toBe(1);
		await trigger.click();
		await pop.getByRole("button", { name: /Claude \(Anthropic\)/ }).click();
		await expect(trigger).toContainText("claude-fixture");
		expect(
			await app.evaluate(
				() => (globalThis as any).providerControl.configs[0].provider,
			),
		).toBe("openai");
		await app.evaluate(() => (globalThis as any).providerControl.finish());
		await expect(
			page.getByRole("button", { name: "Stop worker", exact: true }),
		).toHaveCount(0);
		await page.getByLabel("Task", { exact: true }).fill("Second mocked turn");
		await page.getByRole("button", { name: /Run task/ }).click();
		await expect
			.poll(() =>
				app.evaluate(() => (globalThis as any).providerControl.configs.length),
			)
			.toBe(2);
		expect(
			await app.evaluate(
				() => (globalThis as any).providerControl.configs[1].provider,
			),
		).toBe("anthropic");
		await app.evaluate(() => (globalThis as any).providerControl.finish());
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Status", exact: true }).click();
		const d = page.getByRole("button", { name: "Default model", exact: true });
		await d.click();
		const dp = page.getByRole("dialog", { name: "Default model", exact: true });
		await dp.getByRole("button", { name: /OpenAI/ }).click();
		await expect(d).toContainText("gpt-4o");
		await page.screenshot({ path: "test-results/provider-app-settings.png" });
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		const restored = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(restored.defaultModel).toEqual({
			provider: "openai",
			model: "gpt-4o",
		});
		expect(restored.projects[0].sessions[0].provider).toBe("anthropic");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Status", exact: true }).click();
		await app.evaluate(() => {
			(globalThis as any).providerControl.fail = true;
		});
		await page
			.getByRole("button", { name: "Default model", exact: true })
			.click();
		await expect(
			page
				.getByRole("dialog", { name: "Default model", exact: true })
				.getByRole("alert"),
		).toContainText("Catalog unavailable");
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("dialog", { name: "Default model", exact: true }),
		).toHaveCount(0);
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

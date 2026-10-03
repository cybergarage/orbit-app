import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("Electron renderer security, project/session persistence, repeated submit, cancel, health reconnect", async () => {
	test.skip(
		!!process.env.CI,
		"Live Docker/Ollama interaction is checked locally on the M4",
	);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-ui-"));
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch();
	let page = await app.firstWindow();
	await expect(
		page.getByRole("heading", { name: "Your local agent workspace" }),
	).toBeVisible();
	const security = await app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows()[0];
		return (w.webContents as any).getLastWebPreferences();
	});
	expect(security.nodeIntegration).toBe(false);
	expect(security.contextIsolation).toBe(true);
	expect(security.sandbox).toBe(true);
	expect(await page.evaluate(() => typeof (window as any).require)).toBe(
		"undefined",
	);
	await page.getByLabel("New project").fill("UI fixture");
	await page.locator("form button").click();
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "+ Session" }).click();
	await expect(
		page.getByRole("heading", { name: "Session 2", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Check connections" }).click();
	await expect(page.getByText("Ollama online")).toBeVisible();
	await page
		.getByLabel("Task", { exact: true })
		.fill("Reply with one short sentence. Do not use tools.");
	await page.getByRole("button", { name: "Run task" }).dblclick();
	await expect(page.getByRole("button", { name: "Stop worker" })).toBeVisible();
	await page.getByRole("button", { name: "Stop worker" }).click();
	await expect(page.getByRole("button", { name: "Run task" })).toBeVisible({
		timeout: 15000,
	});
	expect(await page.locator("article.user").count()).toBe(1);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.screenshot({ path: "test-results/desktop.png" });
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	await expect(page.getByRole("button", { name: /UI fixture/ })).toBeVisible();
	await page.getByRole("button", { name: "Session 2", exact: true }).click();
	await expect(page.locator("article.user")).toHaveCount(1);
	await page.getByRole("button", { name: "Check connections" }).click();
	await expect(page.getByText("Docker online")).toBeVisible();
	await app.close();
});

test("desktop project lifecycle and renderer IPC validation without a model", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-app-ui-basic-"));
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch();
	let page = await app.firstWindow();
	await page.getByLabel("New project").fill("Persistent project");
	await page.locator("form button").click();
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "+ Session" }).click();
	await expect(
		page.getByRole("heading", { name: "Session 2", exact: true }),
	).toBeVisible();
	const denied = await page.evaluate(async () => {
		try {
			await window.orbit.call("read-host-file", { path: "/etc/passwd" });
			return false;
		} catch {
			return true;
		}
	});
	expect(denied).toBe(true);
	expect(await page.evaluate(() => typeof (window as any).require)).toBe(
		"undefined",
	);
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	await expect(
		page.getByRole("button", { name: /Persistent project/ }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Session 2", exact: true }),
	).toBeVisible();
	await app.close();
});

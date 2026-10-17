import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("initialization settings show three gated scopes without data changes or a core call", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-initialization-ui-"),
	);
	const app = await electron.launch({
		args: process.env.CI ? [".", "--no-sandbox"] : ["."],
		env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page
			.locator("aside")
			.getByRole("button", { name: "Initialization", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Initialization", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("status")).toContainText("pinned 0.9.2");
		await expect(
			page.getByText(`App storage: ${root}`, { exact: true }),
		).toBeVisible();
		const buttons = page.getByRole("button", { name: /^Review reset/ });
		await expect(buttons).toHaveCount(3);
		for (const button of await buttons.all())
			await expect(button).toBeDisabled();
		const state = JSON.parse(
			await fs.readFile(path.join(root, "state.json"), "utf8"),
		);
		expect(state.projects).toEqual([]);
		expect(state.schedules).toEqual([]);
		await expect(
			page.getByText("No reset or backup is performed by this screen.", {
				exact: false,
			}),
		).toBeVisible();
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store";

async function fixture() {
	const base = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-initialization-ui-")),
	);
	const root = path.join(base, "profile");
	const workspace = path.join(base, "working-files");
	await fs.mkdir(workspace);
	await fs.writeFile(
		path.join(workspace, "AGENTS.md"),
		"Retain workspace guidance",
	);
	await fs.writeFile(
		path.join(workspace, "keep.txt"),
		"Retain working artifact",
	);
	const store = new Store(root);
	await store.init();
	const p = await store.createProject("Initialization fixture", workspace);
	await store.createSession(p.id);
	store.state.appearance = "dark";
	await store.save();
	await store.close();
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	return { base, root, workspace, launch };
}
async function openInitialization(page: any) {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.locator("aside")
		.getByRole("button", { name: "Initialization", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Initialization", exact: true }),
	).toBeVisible();
}
for (const mode of ["settings", "data", "all"] as const)
	test(`initialization ${mode}: preview, shutdown, explicit consent, retained workspace and restart`, async () => {
		const f = await fixture();
		let app = await f.launch();
		try {
			let page = await app.firstWindow();
			await openInitialization(page);
			await expect(
				page.getByText(`App storage: ${f.root}`, { exact: true }),
			).toBeVisible();
			const labels = {
				settings: "Review reset settings",
				data: "Review reset conversations, projects and schedules",
				all: "Review reset all app settings, saved data and owned cache",
			};
			await expect(
				page.getByRole("button", { name: labels.settings, exact: true }),
			).toBeDisabled();
			await expect(
				page.getByRole("button", { name: labels.data, exact: true }),
			).toBeEnabled();
			if (mode !== "data")
				await page
					.getByLabel("Explicitly include App settings (appearance only)")
					.check();
			await page
				.getByRole("button", { name: labels[mode], exact: true })
				.click();
			await expect(
				page.getByRole("heading", { name: "Preview targets", exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Permanently initialize" }),
			).toHaveCount(0);
			await page
				.getByRole("button", {
					name: "Stop App writers and review final targets",
					exact: true,
				})
				.click();
			await expect(
				page.getByRole("heading", { name: "Final initialization targets" }),
			).toBeVisible();
			const action = page.getByRole("button", {
				name: "Permanently initialize",
				exact: true,
			});
			await expect(action).toBeDisabled();
			await page
				.getByLabel("Permanent confirmation", { exact: true })
				.fill("INITIALIZE");
			await expect(action).toBeDisabled();
			await page
				.getByLabel(
					"I have stopped all external writers, disabled automatic restarters, and have exclusive control of this App storage.",
				)
				.check();
			await expect(action).toBeEnabled();
			if (mode === "all")
				await page.screenshot({
					path: "test-results/initialization-final-preview.png",
					fullPage: true,
				});
			await action.click();
			await expect(page.getByRole("status")).toContainText(
				"Initialization completed",
			);
			await expect(
				page.getByRole("button", { name: "Restart App", exact: true }),
			).toBeVisible();
			expect(
				await fs.readFile(path.join(f.workspace, "keep.txt"), "utf8"),
			).toBe("Retain working artifact");
			expect(
				await fs.readFile(path.join(f.workspace, "AGENTS.md"), "utf8"),
			).toBe("Retain workspace guidance");
			await expect(
				page.getByRole("button", { name: "Permanently initialize" }),
			).toHaveCount(0);
			// Verify the real restart IPC invokes relaunch/quit without spawning an unmanaged test App.
			if (mode === "settings") {
				await app.evaluate(({ app: host }) => {
					host.relaunch = () => {};
				});
				const closed = app.waitForEvent("close");
				await page
					.getByRole("button", { name: "Restart App", exact: true })
					.click();
				await closed;
			} else await app.close();
			app = await f.launch();
			page = await app.firstWindow();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible();
			const snapshot = await page.evaluate(() => window.orbit.call("snapshot"));
			expect(snapshot.projects.length).toBe(mode === "settings" ? 1 : 0);
			expect(snapshot.appearance).toBe(mode === "data" ? "dark" : "system");
			expect(
				(await page.evaluate(() => window.orbit.call("initialization-status")))
					.maintenance,
			).toBe(false);
		} finally {
			await app.close().catch(() => {});
			await fs.rm(f.base, { recursive: true, force: true });
		}
	});

test("unknown data refuses reset, shows failure and stays offline after restart", async () => {
	const f = await fixture();
	let app = await f.launch();
	try {
		let page = await app.firstWindow();
		await openInitialization(page);
		await fs.writeFile(
			path.join(f.root, "registry", "unknown.txt"),
			"Do not remove",
		);
		await page
			.getByRole("button", {
				name: "Review reset conversations, projects and schedules",
				exact: true,
			})
			.click();
		await expect(page.getByRole("alert")).toContainText(
			"Unknown object retained",
		);
		await page
			.getByRole("button", {
				name: "Stop App writers and review final targets",
				exact: true,
			})
			.click();
		await expect(page.getByRole("alert")).toContainText(
			"Unknown object retained",
		);
		expect(
			await fs.readFile(path.join(f.root, "registry", "unknown.txt"), "utf8"),
		).toBe("Do not remove");
		await app.close();
		app = await f.launch();
		page = await app.firstWindow();
		await expect(
			page.getByRole("heading", { name: "Initialization", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("alert")).toContainText(
			"Unknown object retained",
		);
		const denied = await page.evaluate(async () => {
			try {
				await window.orbit.call("create-project", {
					name: "Forbidden during maintenance",
				});
				return false;
			} catch {
				return true;
			}
		});
		expect(denied).toBe(true);
	} finally {
		await app.close().catch(() => {});
		await fs.rm(f.base, { recursive: true, force: true });
	}
});

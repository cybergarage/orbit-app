import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("approved appearance, compact folders and schedule creation/editing preserve real metadata", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-spec-ui-"));
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch(),
		page = await app.firstWindow();
	try {
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(
			page
				.locator("aside")
				.getByRole("button", { name: "Appearance", exact: true }),
		).toBeVisible();
		expect(await page.locator("nav button").allTextContents()).toEqual([
			"Home",
			"Scheduled",
			"Settings",
		]);
		await page.getByRole("button", { name: /Dark/ }).click();
		await expect(page.locator("html")).toHaveAttribute(
			"data-appearance",
			"dark",
		);
		expect(
			await page
				.locator("body")
				.evaluate((e) => getComputedStyle(e).backgroundColor),
		).toBe("rgb(29, 33, 31)");
		await page.screenshot({ path: "test-results/appearance-dark.png" });
		await page.getByRole("button", { name: /System/ }).click();
		await page.emulateMedia({ colorScheme: "light" });
		await expect(page.locator("body")).toHaveCSS(
			"background-color",
			"rgb(250, 249, 246)",
		);
		await page.emulateMedia({ colorScheme: "dark" });
		await expect(page.locator("body")).toHaveCSS(
			"background-color",
			"rgb(29, 33, 31)",
		);
		await page.getByRole("button", { name: /Light/ }).click();
		await expect(page.locator("html")).toHaveAttribute(
			"data-appearance",
			"light",
		);
		await page.screenshot({ path: "test-results/appearance-light.png" });
		await page
			.locator("aside")
			.getByRole("button", { name: "Status", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Status", exact: true }),
		).toBeVisible();
		await page.screenshot({ path: "test-results/settings-status.png" });
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await expect(page.locator("html")).toHaveAttribute(
			"data-appearance",
			"light",
		);
		const ids = await page.evaluate(async () => {
			const p = await window.orbit.call("create-project", {
				name: "A long project name for readable compact navigation",
			});
			const s = await window.orbit.call("create-session", { projectId: p.id });
			await window.orbit.call("select-model", {
				projectId: p.id,
				sessionId: s.id,
				model: "deliberately-uninstalled-ui-fixture",
			});
			return { p: p.id, s: s.id };
		});
		const project = page.getByRole("button", {
			name: "Project A long project name for readable compact navigation",
			exact: true,
		});
		await project.click();
		await expect(project).toHaveAttribute("aria-expanded", "true");
		await expect(
			page.getByRole("button", { name: "Chat 1", exact: true }),
		).toBeVisible();
		await expect(project.locator("img")).toHaveAttribute("src", /folder-open/);
		await project.click();
		await expect(project).toHaveAttribute("aria-expanded", "false");
		await expect(
			page.getByRole("button", { name: "Chat 1", exact: true }),
		).toHaveCount(0);
		await expect(project.locator("img")).toHaveAttribute(
			"src",
			/folder-closed/,
		);
		await project.click();
		expect(
			await project.evaluate((e) => e.getBoundingClientRect().height),
		).toBe(26);
		await page.getByRole("button", { name: "Chat 1", exact: true }).click();
		await page.screenshot({ path: "test-results/compact-list.png" });
		const typography = await page
			.locator("h1,h2,label,button,small,pre")
			.evaluateAll((elements) =>
				elements
					.filter((e) => e.getBoundingClientRect().height > 0)
					.map((e) => ({
						size: getComputedStyle(e).fontSize,
						line: getComputedStyle(e).lineHeight,
					})),
			);
		expect(
			typography.every((t) => t.size === "10px" && t.line === "15px"),
		).toBe(true);
		await page.evaluate(() =>
			window.orbit.call("appearance", { value: "dark" }),
		);
		await expect(page.locator("html")).toHaveAttribute(
			"data-appearance",
			"dark",
		);
		const debug = page.getByRole("button", { name: "Debug", exact: true });
		await expect(debug.locator("img")).toHaveCSS(
			"filter",
			"brightness(0) invert(0.85)",
		);
		await debug.click();
		await expect
			.poll(() =>
				page
					.getByRole("button", { name: "Close Debug", exact: true })
					.locator("img")
					.evaluate(
						(image: HTMLImageElement) =>
							image.complete && image.naturalWidth > 0,
					),
			)
			.toBe(true);
		await page.screenshot({ path: "test-results/appearance-dark-debug.png" });
		await page
			.getByRole("button", { name: "Close Debug", exact: true })
			.click();
		await page.evaluate(() =>
			window.orbit.call("appearance", { value: "light" }),
		);
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		await page
			.locator("aside")
			.getByRole("button", { name: "+ New task", exact: true })
			.click();
		await expect(page.getByLabel("Schedule recurrence")).toHaveValue("none");
		await expect(page.getByLabel("First run", { exact: true })).toHaveValue(
			"900000",
		);
		await page
			.getByLabel("Task input")
			.fill("Keep this input through corrective validation");
		await page
			.getByLabel("First run", { exact: true })
			.selectOption("absolute");
		await page
			.getByLabel("Local date and time", { exact: true })
			.fill("2000-01-01T00:00");
		await expect(page.getByRole("alert")).toContainText("time has passed");
		await expect(
			page.getByRole("button", { name: "Schedule task", exact: true }),
		).toBeEnabled();
		await page
			.getByRole("button", { name: "Schedule task", exact: true })
			.click();
		expect(
			(await page.evaluate(() => window.orbit.call("snapshot"))).schedules,
		).toHaveLength(0);
		await page.screenshot({ path: "test-results/schedule-past.png" });
		await page
			.getByRole("button", { name: "Use 15 minutes from creation" })
			.click();
		await expect(page.getByLabel("Task input")).toHaveValue(
			"Keep this input through corrective validation",
		);
		await page.getByLabel("Schedule recurrence").selectOption("15");
		await page.getByLabel("Time zone", { exact: true }).fill("Asia/Tokyo");
		await page.screenshot({ path: "test-results/schedule-preview.png" });
		const before = Date.now();
		await page
			.getByRole("button", { name: "Schedule task", exact: true })
			.click();
		await expect(
			page
				.locator("main")
				.getByRole("heading", { name: "Scheduled", exact: true }),
		).toBeVisible();
		const saved = (await page.evaluate(() => window.orbit.call("snapshot")))
			.schedules[0];
		expect(saved.projectId).toBe(ids.p);
		expect(saved.nextAt).toBeGreaterThanOrEqual(before + 900000);
		expect(saved.nextAt).toBeLessThanOrEqual(Date.now() + 900000);
		expect(saved.plan.timeZone).toBe("Asia/Tokyo");
		await page
			.getByRole("button", { name: "Edit schedule", exact: true })
			.click();
		await page.getByLabel("Task input").fill("Only the task changed");
		await page
			.getByRole("button", { name: "Save schedule", exact: true })
			.click();
		const edited = (await page.evaluate(() => window.orbit.call("snapshot")))
			.schedules[0];
		expect(edited.plan.firstAt).toBe(saved.plan.firstAt);
		expect(edited.nextAt).toBe(saved.nextAt);
		await page.screenshot({ path: "test-results/schedule-list.png" });
		await page
			.locator("aside")
			.getByRole("button", { name: "+ New task", exact: true })
			.click();
		await expect(page.getByLabel("Schedule recurrence")).toHaveValue("none");
		await expect(page.getByLabel("First run", { exact: true })).toHaveValue(
			"900000",
		);
		await page.getByLabel("Schedule recurrence").selectOption("daily");
		await expect(page.getByLabel("Calendar time")).toHaveValue("09:00");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: /Dark/ }).click();
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		await page
			.locator("aside")
			.getByRole("button", { name: "+ New task", exact: true })
			.click();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].setSize(940, 760),
		);
		await page.screenshot({ path: "test-results/schedule-dark-narrow.png" });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		const legacy = await page.evaluate(
			async ({ p, s }) =>
				window.orbit.call("schedule", {
					projectId: p,
					sessionId: s,
					prompt: "Legacy elapsed daily",
					model: "deliberately-uninstalled-ui-fixture",
					nextAt: Date.now() + 86400000,
					intervalMs: 86400000,
				}),
			ids,
		);
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		await page
			.locator(".card")
			.filter({ hasText: "Legacy elapsed daily" })
			.getByRole("button", { name: "Edit schedule", exact: true })
			.click();
		await expect(page.getByLabel("Repeat count")).toHaveValue("1440");
		await page
			.getByLabel("Task input")
			.fill("Legacy task edited without timing change");
		await page
			.getByRole("button", { name: "Save schedule", exact: true })
			.click();
		await expect(
			page
				.locator("main")
				.getByRole("heading", { name: "Scheduled", exact: true }),
		).toBeVisible();
		const savedLegacy = await page.evaluate(
			async (id) =>
				(await window.orbit.call("snapshot")).schedules.find(
					(s: any) => s.id === id,
				),
			legacy.id,
		);
		expect(savedLegacy.nextAt).toBe(legacy.nextAt);
		expect(savedLegacy.intervalMs).toBe(86400000);
		expect(savedLegacy.plan).toBeUndefined();
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

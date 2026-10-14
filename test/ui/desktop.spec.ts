import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-approved-ui-"));
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	return { root, launch };
}
test("project create/edit cancel, session rename/move, outside/ESC dismissal and restart preserve history", async () => {
	const { root, launch } = await fixture();
	let app = await launch();
	let page = await app.firstWindow();
	const security = await app.evaluate(({ BrowserWindow }) =>
		(
			BrowserWindow.getAllWindows()[0].webContents as any
		).getLastWebPreferences(),
	);
	expect(security.nodeIntegration).toBe(false);
	expect(security.contextIsolation).toBe(true);
	expect(security.sandbox).toBe(true);
	await expect(
		page.getByRole("heading", { name: "What can I help with?" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "+ New project", exact: true })
		.click();
	await page.getByLabel("Project name *").fill("Cancelled");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByRole("button", { name: /Cancelled/ })).toHaveCount(0);
	for (const name of ["A", "B"]) {
		await page
			.getByRole("button", { name: "+ New project", exact: true })
			.click();
		await page.getByLabel("Project name *").fill(name);
		expect(
			await page
				.getByRole("button", { name: "Create project", exact: true })
				.getAttribute("type"),
		).toBe("submit");
		await page
			.getByRole("button", { name: "Create project", exact: true })
			.click();
	}
	await page.getByRole("button", { name: "⌄ A", exact: true }).click();
	// Create idle session through the same renderer IPC used by New chat submit.
	const initial = await page.evaluate(async () => {
		const state = await window.orbit.call("snapshot");
		return window.orbit.call("create-session", {
			projectId: state.projects.find((p: any) => p.name === "A").id,
		});
	});
	await page.getByRole("button", { name: "Session 1", exact: true }).click();
	await page
		.getByRole("button", { name: "Session menu Session 1", exact: true })
		.click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Session 1", exact: true })
		.click({ button: "right" });
	await expect(page.getByRole("menu")).toBeVisible();
	// The click sits over Scheduled. The scrim must absorb it, without navigation.
	await page.mouse.click(35, 112);
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Session menu Session 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Rename session" }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/session-dialog.png" });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Session menu Session 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.getByLabel("Session name").fill("Renamed");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Session 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Session menu Session 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.getByLabel("Session name").fill("Renamed");
	await page.getByRole("button", { name: "Save name", exact: true }).click();
	await page
		.getByRole("button", { name: "Session menu Renamed", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Move to project", exact: true })
		.click();
	await page.getByLabel("Destination project").selectOption({ label: "B" });
	await page.getByRole("button", { name: "Move session", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Renamed", exact: true }),
	).toBeVisible();
	const moved = await page.evaluate(async () => window.orbit.call("snapshot"));
	expect(moved.projects.find((p: any) => p.name === "A").sessions).toHaveLength(
		0,
	);
	expect(
		moved.projects.find((p: any) => p.name === "B").sessions[0]
			.storageProjectId,
	).toBe(initial.projectId);
	await page
		.getByRole("button", { name: "Project menu B", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Edit project", exact: true })
		.click();
	await page.getByLabel("Project name *").fill("Edited B");
	await page.getByLabel("Instructions · optional").fill("Project guidance");
	await page.getByRole("button", { name: "Save project", exact: true }).click();
	await page.getByRole("button", { name: "Scheduled", exact: true }).click();
	await page
		.getByRole("button", { name: "Execution history", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "No executions yet" }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/scheduled-empty.png" });
	await page.getByRole("button", { name: /Runtime/ }).click();
	await page.getByRole("button", { name: "Recheck", exact: true }).click();
	await expect(
		page.getByText(/Worker image · (Available|Unavailable)/),
	).toBeVisible();
	await page.screenshot({ path: "test-results/runtime.png" });
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	await page.getByRole("button", { name: "Renamed", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Renamed", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "⌄ Edited B", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => typeof (window as any).require)).toBe(
		"undefined",
	);
	const denied = await page.evaluate(async () => {
		try {
			await window.orbit.call("read-host-file", { path: "/etc/passwd" });
			return false;
		} catch {
			return true;
		}
	});
	expect(denied).toBe(true);
	await page.screenshot({ path: "test-results/desktop.png" });
	await app.close();
	expect(
		JSON.parse(
			await fs.readFile(path.join(root, "state.json"), "utf8"),
		).projects.find((p: any) => p.name === "Edited B").instructions,
	).toBe("Project guidance");
});

test("persisted execution detail, interrupted state and disabled session menu use stored data", async () => {
	const { root, launch } = await fixture();
	const p = randomUUID(),
		s = randomUUID(),
		scheduleId = randomUUID(),
		runId = randomUUID();
	await fs.writeFile(
		path.join(root, "state.json"),
		JSON.stringify({
			projects: [
				{
					id: p,
					name: "History fixture",
					sessions: [
						{
							id: s,
							name: "Recovering",
							status: "recovery-blocked",
							events: Array.from({ length: 40 }, (_, i) => ({
								id: randomUUID(),
								type: "error",
								at: new Date().toISOString(),
								data: `History event ${i}`,
							})),
						},
					],
				},
			],
			schedules: [],
			executions: [
				{
					id: runId,
					scheduleId,
					projectId: p,
					sessionId: s,
					projectName: "History fixture",
					requestId: randomUUID(),
					dueAt: Date.now() - 1000,
					startedAt: Date.now() - 1000,
					prompt: "Stored input",
					model: "fixture model",
					status: "running",
					events: [
						{
							id: randomUUID(),
							type: "approval-decision",
							at: new Date().toISOString(),
							data: { approve: false },
						},
					],
				},
			],
		}),
	);
	const app = await launch(),
		page = await app.firstWindow();
	await page.getByRole("button", { name: "Recovering", exact: true }).click();
	await page.locator(".timeline").evaluate((element) => {
		element.scrollTop = 150;
	});
	const scrollBefore = await page
		.locator(".timeline")
		.evaluate((element) => element.scrollTop);
	await page
		.getByRole("button", { name: "Session menu Recovering", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Rename", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("menuitem", { name: "Move to project", exact: true }),
	).toBeDisabled();
	await page.screenshot({ path: "test-results/session-menu.png" });
	await page.keyboard.press("Escape");
	expect(
		await page.locator(".timeline").evaluate((element) => element.scrollTop),
	).toBe(scrollBefore);
	await page.getByRole("button", { name: "Scheduled", exact: true }).click();
	await page
		.getByRole("button", { name: "Execution history", exact: true })
		.click();
	await expect(page.getByText("interrupted", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "View details", exact: true }).click();
	await expect(page.getByText("Stored input", { exact: true })).toBeVisible();
	await expect(page.getByText("No answer yet", { exact: true })).toBeVisible();
	await expect(page.getByText(/approval-decision/)).toBeVisible();
	await page.screenshot({ path: "test-results/execution-details.png" });
	await app.close();
});

test("Home layout and Figma dock assets render locally with exact 24px geometry", async () => {
	const { launch } = await fixture(),
		app = await launch(),
		page = await app.firstWindow();
	await page.screenshot({ path: "test-results/home.png" });
	for (const icon of await page.locator(".dock img").all()) {
		const geometry = await icon.evaluate((img) => ({
			width: img.getBoundingClientRect().width,
			height: img.getBoundingClientRect().height,
			loaded: (img as HTMLImageElement).naturalWidth > 0,
			src: (img as HTMLImageElement).src,
		}));
		expect(geometry.width).toBe(24);
		expect(geometry.height).toBe(24);
		expect(geometry.loaded).toBe(true);
		expect(geometry.src).toContain("/dist/assets/");
	}
	await page
		.getByRole("button", { name: "+ New project", exact: true })
		.click();
	await page.screenshot({ path: "test-results/new-project.png" });
	await app.close();
});

test("real scheduler admission failure is durable and shown without an invented answer", async () => {
	const { root, launch } = await fixture();
	const p = randomUUID(),
		s = randomUUID();
	await fs.writeFile(
		path.join(root, "state.json"),
		JSON.stringify({
			projects: [
				{
					id: p,
					name: "Schedule fixture",
					sessions: [
						{ id: s, name: "Scheduled chat", status: "idle", events: [] },
					],
				},
			],
			schedules: [
				{
					id: randomUUID(),
					projectId: p,
					sessionId: s,
					prompt: "Actual scheduled input",
					model: "deliberately-uninstalled-fixture-model",
					nextAt: Date.now() - 1000,
					intervalMs: 0,
					enabled: true,
				},
			],
		}),
	);
	const app = await launch(),
		page = await app.firstWindow();
	try {
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		await page
			.getByRole("button", { name: "Execution history", exact: true })
			.click();
		await expect(page.getByText("failed", { exact: true })).toBeVisible({
			timeout: 25000,
		});
		await page
			.getByRole("button", { name: "View details", exact: true })
			.click();
		await expect(
			page.getByText("Actual scheduled input", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("No answer yet", { exact: true }),
		).toBeVisible();
		await page.screenshot({ path: "test-results/scheduled-failure.png" });
		const state = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(state.executions).toHaveLength(1);
		expect(state.executions[0].events[0].type).toBe("error");
		expect(state.schedules[0].enabled).toBe(false);
	} finally {
		await app.close();
	}
	const saved = JSON.parse(
		await fs.readFile(path.join(root, "state.json"), "utf8"),
	);
	expect(saved.executions[0].status).toBe("failed");
	expect(saved.executions[0].endedAt).toBeTruthy();
});

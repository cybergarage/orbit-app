import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/store";
import { resolveSchedule } from "../../src/scheduling";

test("schedule controls confirm deletion, retain disabled edits, report expiry and persist across restart", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-schedule-ui-"));
	const store = new Store(root);
	await store.init();
	const project = await store.createProject("Schedule fixture");
	const session = await store.createSession(project.id);
	const file = path.join(store.workspace(project.id), "keep.txt");
	await fs.writeFile(file, "Keep workspace artifact");
	const recurringId = randomUUID(),
		oneTimeId = randomUUID();
	for (const [id, prompt, old] of [
		[recurringId, "Recurring fixture", false],
		[oneTimeId, "Elapsed one-time fixture", true],
	] as const) {
		const plan = resolveSchedule(
			{
				first: { kind: "relative", delayMs: 3600000 },
				timeZone: "UTC",
				repeat: old ? { kind: "none" } : { kind: "interval", minutes: 15 },
			},
			Date.now() - (old ? 86400000 : 0),
		);
		store.state.schedules.push({
			id,
			projectId: project.id,
			sessionId: session.id,
			prompt,
			model: "fixture",
			enabled: !old,
			nextAt: plan.firstAt,
			intervalMs: old ? 0 : 900000,
			plan,
		});
	}
	store.state.executions = [
		{
			id: randomUUID(),
			scheduleId: recurringId,
			projectId: project.id,
			sessionId: session.id,
			projectName: project.name,
			requestId: randomUUID(),
			dueAt: 1,
			startedAt: 1,
			endedAt: 2,
			prompt: "Retain synthetic history",
			model: "fixture",
			status: "completed",
			answer: "Stored answer",
			events: [],
		},
	];
	await store.save();
	await store.close();
	const launch = () =>
		electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		let recurring = page.getByRole("article", {
			name: "Scheduled task: Recurring fixture",
			exact: true,
		});
		const before = await page.evaluate(() => window.orbit.call("snapshot"));
		const firstAt = before.schedules.find(
			(s: any) => s.id === recurringId,
		)?.nextAt;
		await recurring
			.getByRole("button", { name: "Disable", exact: true })
			.click();
		await expect(
			recurring.getByRole("button", { name: "Enable", exact: true }),
		).toBeEnabled();
		await recurring
			.getByRole("button", { name: "Enable", exact: true })
			.click();
		await expect(
			recurring.getByRole("button", { name: "Disable", exact: true }),
		).toBeEnabled();
		const enabled = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(
			enabled.schedules.find((s: any) => s.id === recurringId)?.nextAt,
		).toBe(firstAt);
		await recurring
			.getByRole("button", { name: "Disable", exact: true })
			.click();
		await expect(
			recurring.getByRole("button", { name: "Enable", exact: true }),
		).toBeEnabled();
		await recurring
			.getByRole("button", { name: "Edit schedule", exact: true })
			.click();
		await expect(
			page.getByText(/Saving edits keeps it disabled/),
		).toBeVisible();
		await page.getByLabel("Task input").fill("Edited disabled fixture");
		await page
			.getByRole("button", { name: "Save schedule", exact: true })
			.click();
		recurring = page.getByRole("article", {
			name: "Scheduled task: Edited disabled fixture",
			exact: true,
		});
		await expect(
			recurring.getByRole("button", { name: "Enable", exact: true }),
		).toBeEnabled();
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		recurring = page.getByRole("article", {
			name: "Scheduled task: Edited disabled fixture",
			exact: true,
		});
		await expect(
			recurring.getByRole("button", { name: "Enable", exact: true }),
		).toBeEnabled();
		const once = page.getByRole("article", {
			name: "Scheduled task: Elapsed one-time fixture",
			exact: true,
		});
		await once.getByRole("button", { name: "Enable", exact: true }).click();
		await expect(once.getByRole("alert")).toContainText(
			"Edit its first-run time",
		);
		await expect(
			once.getByRole("button", { name: "Enable", exact: true }),
		).toBeEnabled();
		await once
			.getByRole("button", { name: "Edit schedule", exact: true })
			.click();
		await page.getByLabel("First run", { exact: true }).selectOption("900000");
		await page
			.getByRole("button", { name: "Save schedule", exact: true })
			.click();
		await once.getByRole("button", { name: "Enable", exact: true }).click();
		await expect(
			once.getByRole("button", { name: "Disable", exact: true }),
		).toBeEnabled();
		await recurring
			.getByRole("button", { name: "Delete task", exact: true })
			.click();
		let dialog = page.getByRole("dialog", {
			name: "Delete scheduled task",
			exact: true,
		});
		await expect(dialog).toContainText(
			"Chats, working files and execution history remain",
		);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await recurring
			.getByRole("button", { name: "Delete task", exact: true })
			.click();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await recurring
			.getByRole("button", { name: "Delete task", exact: true })
			.click();
		dialog = page.getByRole("dialog", {
			name: "Delete scheduled task",
			exact: true,
		});
		await dialog
			.getByRole("button", { name: "Delete scheduled task", exact: true })
			.click();
		await expect(recurring).toHaveCount(0);
		await expect(once).toBeVisible();
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		const snapshot = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(snapshot.schedules.map((s: any) => s.id)).toEqual([oneTimeId]);
		expect(snapshot.schedules[0].enabled).toBe(true);
		expect(snapshot.executions).toHaveLength(1);
		expect(snapshot.executions[0].answer).toBe("Stored answer");
		expect(snapshot.projects[0].sessions[0].id).toBe(session.id);
		expect(await fs.readFile(file, "utf8")).toBe("Keep workspace artifact");
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

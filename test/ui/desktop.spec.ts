import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContainerCoreNames } from "../../src/core-names";
const testRoots: string[] = [];
const testApps: Awaited<ReturnType<typeof electron.launch>>[] = [];
test.afterEach(async () => {
	await Promise.all(
		testApps.splice(0).map((app) => app.close().catch(() => {})),
	);
	await Promise.all(
		testRoots
			.splice(0)
			.map((root) => fs.rm(root, { recursive: true, force: true })),
	);
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-approved-ui-"));
	testRoots.push(root);
	const launch = async () => {
		const stateFile = path.join(root, "state.json");
		const seed = await fs
			.readFile(stateFile, "utf8")
			.then(JSON.parse)
			.catch(() => undefined);
		if (seed?.projects?.length && seed.namesVersion !== 1) {
			const names = new ContainerCoreNames(root);
			for (const project of seed.projects) {
				const core = path.join(root, "projects", project.id, "core");
				await names.call(core, {
					command: "create-project",
					projectId: project.id,
					name: project.name,
				});
				for (const session of project.sessions) {
					await names.call(core, {
						command: "create-session",
						sessionId: session.id,
						name: session.name,
						operationId: randomUUID(),
					});
					await names.call(core, {
						command: "rename-session",
						sessionId: session.id,
						name: session.name,
						expectedRevision: 0,
						operationId: randomUUID(),
					});
				}
			}
			seed.namesVersion = 1;
			await fs.writeFile(stateFile, JSON.stringify(seed));
		}

		const app = await electron.launch({
			args: process.env.CI ? [".", "--no-sandbox"] : ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
		testApps.push(app);
		return app;
	};
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
		await expect(
			page.getByText(`Start a conversation in ${name}.`, { exact: true }),
		).toBeVisible({ timeout: 30000 });
	}
	await page.getByRole("button", { name: "Project A", exact: true }).click();
	// Create idle session through the same renderer IPC used by New chat submit.
	const initial = await page.evaluate(async () => {
		const state = await window.orbit.call("snapshot");
		return window.orbit.call("create-session", {
			projectId: state.projects.find((p: any) => p.name === "A").id,
		});
	});
	await page.getByRole("button", { name: "Chat 1", exact: true }).click();
	await page
		.getByRole("button", { name: "Chat menu Chat 1", exact: true })
		.click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Chat 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Chat 1", exact: true })
		.click({ button: "right" });
	await expect(page.getByRole("menu")).toBeVisible();
	// The click sits over Scheduled. The scrim must absorb it, without navigation.
	await page.mouse.click(35, 112);
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Chat 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Chat menu Chat 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Rename chat" }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/session-dialog.png" });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Chat 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Chat menu Chat 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.getByLabel("Chat name *").fill("Renamed");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Chat 1", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Chat menu Chat 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.getByLabel("Chat name *").fill("Renamed");
	await page.getByRole("button", { name: "Save name", exact: true }).click();
	await page
		.getByRole("button", { name: "Chat menu Renamed", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Move to project", exact: true })
		.click();
	await page.getByLabel("Destination project").selectOption({ label: "B" });
	await page.getByRole("button", { name: "Move chat", exact: true }).click();
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
	await expect(
		page.getByRole("heading", { name: "What can I help with?", exact: true }),
	).toBeVisible();
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
		page.getByRole("button", { name: "Project Edited B", exact: true }),
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
		).projects.find((p: any) => p.instructions === "Project guidance")
			.instructions,
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
		.getByRole("button", { name: "Chat menu Recovering", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Rename", exact: true }),
	).toBeDisabled();
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
	await expect(
		page.getByText("approval-decision", { exact: true }),
	).toBeVisible();
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

test("approved conversation, Debug overlay, project rename and real failed Retry retain user input", async () => {
	const { root, launch } = await fixture();
	const p = randomUUID(),
		s = randomUUID();
	const at = new Date().toISOString();
	await fs.writeFile(
		path.join(root, "state.json"),
		JSON.stringify({
			projects: [
				{
					id: p,
					name: "Design verification",
					sessions: [
						{
							id: s,
							name: "Verify the layout",
							status: "failed",
							model: "deliberately-uninstalled-fixture-model",
							events: [
								{
									id: randomUUID(),
									type: "submission",
									at,
									data: {
										prompt: "Preserve this arbitrary input",
										requestId: randomUUID(),
									},
								},
								{
									id: randomUUID(),
									type: "run",
									at,
									data: { phase: "failed", runId: "synthetic-raw-id" },
								},
								{
									id: randomUUID(),
									type: "error",
									at,
									data: "Synthetic runtime failure",
								},
								{
									id: randomUUID(),
									type: "result",
									at,
									data: {
										answer: "A retained answer",
										runtime: { outcome: "failed", reason: "Synthetic reason" },
									},
								},
							],
						},
					],
				},
			],
			schedules: [],
		}),
	);
	const saved = JSON.parse(
		await fs.readFile(path.join(root, "state.json"), "utf8"),
	);
	const completed = structuredClone(saved.projects[0].sessions[0]);
	completed.id = randomUUID();
	completed.name = "Completed conversation";
	completed.status = "completed";
	completed.events = completed.events.filter((event: any) =>
		["submission", "result"].includes(event.type),
	);
	saved.projects[0].sessions.push(completed);
	await fs.writeFile(path.join(root, "state.json"), JSON.stringify(saved));
	let app = await launch();
	let page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0].setSize(1440, 920),
	);
	await page
		.getByRole("button", { name: "Completed conversation", exact: true })
		.click();
	await expect(page.locator(".chat-status")).toContainText("completed");
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: "Debug", exact: true })
				.locator("img")
				.evaluate(
					(image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
				),
		)
		.toBe(true);
	const debugButtonBounds = await page
		.getByRole("button", { name: "Debug", exact: true })
		.boundingBox();
	if (!debugButtonBounds) throw Error("Debug button is not rendered");
	expect(debugButtonBounds.x + debugButtonBounds.width).toBeLessThanOrEqual(
		1440,
	);
	await page.screenshot({ path: "test-results/approved-normal.png" });
	await page.getByRole("button", { name: "Debug", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Close Debug", exact: true }),
	).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: "Close Debug", exact: true })
				.locator("img")
				.evaluate(
					(image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
				),
		)
		.toBe(true);
	const debugGeometry = await page.locator(".debug-pane").evaluate((pane) => {
		const button = pane.querySelector(".debug-heading button");
		const img = button?.querySelector("img");
		const rect = pane.getBoundingClientRect(),
			icon = img?.getBoundingClientRect();
		return {
			pane: rect.toJSON(),
			icon: icon?.toJSON(),
			loaded: (img as HTMLImageElement)?.naturalWidth,
		};
	});
	await fs.writeFile(
		"test-results/debug-geometry.json",
		JSON.stringify(debugGeometry, null, 2),
	);
	expect(debugGeometry.loaded).toBeGreaterThan(0);
	expect(debugGeometry.icon?.width).toBe(18);
	expect(debugGeometry.icon?.right).toBeLessThan(debugGeometry.pane.right);
	await page.screenshot({ path: "test-results/approved-normal-debug.png" });
	await page.getByRole("button", { name: "Close Debug", exact: true }).click();
	await page
		.getByRole("button", { name: "Verify the layout", exact: true })
		.click();
	await expect(page.getByLabel("Task", { exact: true })).toHaveValue(
		"Preserve this arbitrary input",
	);
	await expect(page.locator(".timeline")).not.toContainText("synthetic-raw-id");
	await expect(page.locator(".timeline")).not.toContainText("Synthetic reason");
	await expect(page.locator(".timeline")).toContainText(
		"The task could not finish",
	);
	await expect(page.getByRole("button", { name: /Retry task/ })).toBeEnabled();
	const boxes = await page
		.locator(".timeline article")
		.evaluateAll((elements) =>
			elements.map((e) => ({
				className: e.className,
				x: e.getBoundingClientRect().x,
				width: e.getBoundingClientRect().width,
				right: e.getBoundingClientRect().right,
			})),
		);
	expect(boxes[0].x).toBeGreaterThan(boxes[1].x);
	await page.screenshot({ path: "test-results/approved-failure.png" });
	await page.getByRole("button", { name: "Debug", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Debug details" }),
	).toBeVisible();
	await expect(page.locator(".debug-events")).toContainText("synthetic-raw-id");
	await page.screenshot({ path: "test-results/approved-debug.png" });
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0].setSize(1000, 920),
	);
	const overlap = await page.evaluate(() => {
		const pane = document.querySelector(".debug-pane")?.getBoundingClientRect();
		const chat = document
			.querySelector(".chat-content")
			?.getBoundingClientRect();
		return !!pane && !!chat && pane.left < chat.right;
	});
	expect(overlap).toBe(true);
	await page.screenshot({ path: "test-results/approved-narrow-debug.png" });
	await page.getByRole("button", { name: "Close Debug", exact: true }).click();
	await expect(page.getByRole("region", { name: "Debug details" })).toHaveCount(
		0,
	);
	await expect(page.locator(".timeline")).toContainText(
		"The task could not finish",
	);
	await page.screenshot({ path: "test-results/approved-narrow.png" });
	await page
		.getByLabel("Task", { exact: true })
		.fill("Edited retry from real input");
	await page.getByRole("button", { name: /Retry task/ }).click();
	await expect(page.getByRole("alert")).toBeVisible({ timeout: 15000 });
	await expect(page.getByLabel("Task", { exact: true })).toHaveValue(
		"Edited retry from real input",
	);
	await page
		.getByRole("button", {
			name: "Project menu Design verification",
			exact: true,
		})
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Rename project", exact: true }),
	).toBeVisible();
	await page.getByLabel("Project name *").fill("A name chosen by the user");
	await page.screenshot({ path: "test-results/approved-project-rename.png" });
	await page.getByRole("button", { name: "Save name", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: "Project A name chosen by the user",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", {
			name: "New chat in A name chosen by the user",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("heading", { name: "Chat 3", exact: true }),
	).toBeVisible({ timeout: 30000 });
	for (const icon of await page.locator("button img").all()) {
		const dimensions = await icon.evaluate((e) => ({
			loaded: (e as HTMLImageElement).naturalWidth > 0,
			w: e.getBoundingClientRect().width,
			h: e.getBoundingClientRect().height,
			dock: !!e.closest(".dock"),
		}));
		expect(dimensions.loaded).toBe(true);
		expect(dimensions.w).toBe(dimensions.dock ? 24 : 18);
		expect(dimensions.h).toBe(dimensions.w);
	}
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	await expect(
		page.getByRole("button", {
			name: "Project A name chosen by the user",
			exact: true,
		}),
	).toBeVisible();
	expect(
		(await fs.readdir(root)).some((name) => name.includes("pre-approved")),
	).toBe(false);
	await app.close();
});

test("core revision conflict keeps the editor input and authoritative title through restart", async () => {
	const { root, launch } = await fixture();
	let app = await launch(),
		page = await app.firstWindow();
	await page
		.getByRole("button", { name: "+ New project", exact: true })
		.click();
	await page.getByLabel("Project name *").fill("Core UI project");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await page
		.getByRole("button", { name: "New chat in Core UI project", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Chat menu Chat 1", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await page.getByLabel("Chat name *").fill("Unsaved editor title");
	const state = await page.evaluate(() => window.orbit.call("snapshot"));
	const project = state.projects[0],
		session = project.sessions[0];
	const core = new ContainerCoreNames(root);
	await core.call(path.join(root, "projects", project.id, "core"), {
		command: "rename-session",
		sessionId: session.id,
		name: "External core title",
		expectedRevision: session.nameRevision,
		operationId: randomUUID(),
	});
	await page.getByRole("button", { name: "Save name", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(/revision|conflict/i);
	await expect(page.getByLabel("Chat name *")).toHaveValue(
		"Unsaved editor title",
	);
	await expect(
		page.getByRole("button", { name: "External core title", exact: true }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/core-title-conflict.png" });
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "External core title", exact: true }),
	).toBeVisible();
	await app.close();
	app = await launch();
	page = await app.firstWindow();
	await page
		.getByRole("button", { name: "External core title", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "External core title", exact: true }),
	).toBeVisible();
	const saved = JSON.parse(
		await fs.readFile(path.join(root, "state.json"), "utf8"),
	);
	expect(saved.projects[0].name).toBeUndefined();
	expect(saved.projects[0].sessions[0].name).toBeUndefined();
	await app.close();
});

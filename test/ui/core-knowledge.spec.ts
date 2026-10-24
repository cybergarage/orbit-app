import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	Agent,
	MemoryProjectStore,
	MemorySessionLogStore,
	Message,
	MessageType,
	OrbitApplicationService,
	SessionRepository,
} from "@cybergarage/orbit";
import { startGuiServer } from "@cybergarage/orbit/dist/apps/gui/server.js";

test("Core GUI automatically learns A and supplies B without manual note selection or preview", async () => {
	test.setTimeout(120000);
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "orbit-core-knowledge-ui-"),
	);
	const repository = new SessionRepository({
		rootDir: path.join(root, "sessions"),
		journalRoot: path.join(root, "runs"),
	});
	repository.initializeStorage({
		allWritersStopped: true,
		automaticRestartersDisabled: true,
		exclusiveStorageControl: true,
	});
	const store = new MemoryProjectStore();
	const inputs: string[] = [];
	const service: OrbitApplicationService = new OrbitApplicationService({
		contexts: [],
		cwd: root,
		settingsSources: [],
		projectStore: store,
		repository,
		model: "synthetic",
		provider: "ollama",
		logStore: new MemorySessionLogStore(),
		knowledgeExtractor: async (input) => {
			const source = JSON.parse(input).messages.find(
				(message: any) =>
					message.role === "user" && message.text.startsWith("Use PostgreSQL"),
			);
			return {
				text: JSON.stringify({
					candidates: source
						? [
								{
									title: "Database",
									body: "Use PostgreSQL for the catalog.",
									kind: "decision",
									condition: "Catalog",
									importance: 3,
									messageId: source.id,
									quote: source.text,
								},
							]
						: [],
				}),
				inputTokens: 200,
				outputTokens: 30,
			};
		},
		createAgent: (options) =>
			new Agent({
				...options,
				projectMemory: service.projectMemory,
				toolProfile: "none",
				deps: {
					createModel: () => ({
						getModel: () => "synthetic",
						getName: () => "synthetic",
						getProvider: () => "ollama",
						async invoke(messages) {
							const content = messages
								.map((message) => message.content)
								.join("\n");
							inputs.push(content);
							return new Message(MessageType.Assistant, {
								content: content.includes("Which database")
									? content.includes("Untrusted Project memory") &&
										content.includes("Use PostgreSQL")
										? "PostgreSQL selected"
										: "NO_MEMORY"
									: "Acknowledged",
							});
						},
					}),
				},
			}),
	});
	const projects = service.projects;
	if (!projects) throw new Error("Project service missing");
	const project = await projects.create({
		name: "Core knowledge",
		operationId: randomUUID(),
	});
	const a = await service.createProjectThread(project.id, {
		operationId: randomUUID(),
	});
	const b = await service.createProjectThread(project.id, {
		operationId: randomUUID(),
	});
	await service.renameSession(a.id, {
		title: "Core decision A",
		expectedRevision: 0,
		operationId: randomUUID(),
	});
	await service.renameSession(b.id, {
		title: "Core question B",
		expectedRevision: 0,
		operationId: randomUUID(),
	});
	const server = await startGuiServer({ service });
	const entry = path.join(root, "main.cjs");
	await build({
		entryPoints: ["test/fixtures/core-gui-main.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["electron"],
		outfile: entry,
	});
	const app = await electron.launch({
		args: process.env.CI ? [entry, "--no-sandbox"] : [entry],
		env: {
			...process.env,
			ORBIT_CORE_GUI_URL: server.url,
			ORBIT_CORE_GUI_PROFILE: path.join(root, "electron"),
		},
	});
	try {
		const page = await app.firstWindow();
		const toggle = page
			.locator(".project-toggle")
			.filter({ hasText: "Core knowledge" });
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) !== "true")
			await toggle.click();
		await page
			.getByRole("button", { name: "Core decision A", exact: true })
			.click();
		await page
			.getByPlaceholder("Ask Orbit to help with this project…")
			.fill("Use PostgreSQL for the catalog.");
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.click();
		await expect(page.getByText("Acknowledged", { exact: true })).toBeVisible();
		await expect
			.poll(
				async () =>
					(
						await store.query({
							kind: "automation-status",
							projectId: project.id,
						})
					).entries.length,
				{ timeout: 30000 },
			)
			.toBe(1);
		await page
			.getByRole("button", { name: "Core question B", exact: true })
			.click();
		await page
			.getByPlaceholder("Ask Orbit to help with this project…")
			.fill("Which database stores the catalog?");
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.click();
		await expect(
			page.getByText("PostgreSQL selected", { exact: true }),
		).toBeVisible();
		expect(inputs.at(-1)).toContain("Untrusted Project memory");
		await page.getByRole("button", {name: "Logs", exact: true}).click();
    await page.getByText("Project memory", { exact: true }).click();
		await expect(page.getByLabel("Project memory mode")).toHaveValue(
			"automatic",
		);
		await page
			.getByRole("button", { name: "Stop automatic extraction", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(await store.query({ kind: "automation", id: project.id }))?.enabled,
			)
			.toBe(false);
		await page
			.getByRole("button", {
				name: "Processing status and budgets",
				exact: true,
			})
			.click();
		await expect(page.locator(".project-memory")).toContainText("inputTokens");
		await page.screenshot({
			path: "/tmp/orbit-knowledge-core-gui.png",
			fullPage: true,
		});
	} finally {
		await app.close();
		await server.close();
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

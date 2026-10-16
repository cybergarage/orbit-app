import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, dockerPath } from "../../src/worker";
test("live tool approval stays visible with Debug closed and runs only after approval", async () => {
	test.skip(
		process.env.ORBIT_APP_LIVE !== "1",
		"Explicit local model verification only",
	);
	test.setTimeout(180000);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-approval-live-"));
	const app = await electron.launch({
		args: ["."],
		env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
	});
	const page = await app.firstWindow();
	try {
		const ids = await page.evaluate(async () => {
			const p = await window.orbit.call("create-project", {
				name: "Synthetic approval verification",
			});
			const s = await window.orbit.call("create-session", { projectId: p.id });
			await window.orbit.call("select-model", {
				projectId: p.id,
				sessionId: s.id,
				model: "gemma4:12b",
			});
			return { p: p.id, s: s.id };
		});
		await page.getByRole("button", { name: "Chat 1", exact: true }).click();
		await page
			.getByLabel("Task", { exact: true })
			.fill(
				"Use the bash tool exactly once to run node -e \"console.log('APPROVAL-7264')\" in /workspace. This harmless command only prints text. Do not use any other tools, read or write any files, or access any external service. Invoke the bash tool now, rather than asking for approval in a text response; Orbit App handles approval for the tool call. After the command succeeds, reply with only APPROVAL-7264.",
			);
		await page.getByRole("button", { name: /Run task/ }).click();
		const approve = page.getByRole("button", { name: "Approve", exact: true });
		await expect(approve).toBeVisible({ timeout: 90000 });
		await expect(
			page.getByRole("region", { name: "Debug details" }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Deny", exact: true }),
		).toBeVisible();
		const before = await page.evaluate(() => window.orbit.call("snapshot"));
		const pending = before.projects.find((p: any) => p.id === ids.p)
			.sessions[0];
		const request = pending.events.findLast(
			(e: any) => e.type === "approval",
		).data;
		expect(request.preview.name).toBe("bash");
		expect(request.preview.command).toBe(
			"node -e \"console.log('APPROVAL-7264')\"",
		);
		expect(pending.status).toBe("awaiting-approval");
		expect(pending.events.some((e: any) => e.type === "approval")).toBe(true);
		expect(
			pending.events.some(
				(e: any) =>
					e.type === "agent-event" && e.data.type === "tool-completed",
			),
		).toBe(false);
		await page.screenshot({ path: "test-results/live-approval.png" });
		await approve.click();
		await expect(
			page.getByRole("button", { name: /(?:Run|Retry) task/ }),
		).toBeVisible({ timeout: 90000 });
		const after = await page.evaluate(() => window.orbit.call("snapshot"));
		const completed = after.projects.find((p: any) => p.id === ids.p)
			.sessions[0];
		expect(completed.status).toBe("completed");
		expect(completed.answer).toContain("APPROVAL-7264");
		expect(
			completed.events.some(
				(e: any) =>
					e.type === "agent-event" &&
					e.data.type === "tool-completed" &&
					e.data.toolCall.name === "bash",
			),
		).toBe(true);
		await fs.writeFile(
			"test-results/approval-live.json",
			JSON.stringify(
				{
					status: "passed",
					model: "gemma4:12b",
					debugClosed: true,
					approvalRequired: true,
					noToolBeforeApproval: true,
					answer: completed.answer,
				},
				null,
				2,
			),
		);
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("live existing-image runtime, inference, actual worker cancel/retry and moved Orbit history resume", async () => {
	test.skip(
		process.env.ORBIT_APP_LIVE !== "1",
		"Explicit local existing-image verification only",
	);
	test.setTimeout(300000);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-approved-live-"));
	const launch = () =>
		electron.launch({
			args: ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch(),
		page = await app.firstWindow();
	const summary: any = {
		root,
		model: "gemma4:12b",
		startedAt: new Date().toISOString(),
	};
	try {
		await page.getByRole("button", { name: /Runtime/ }).click();
		await page.getByRole("button", { name: "Recheck", exact: true }).click();
		await expect(
			page.getByText("3/3 checks passed", { exact: true }),
		).toBeVisible({ timeout: 15000 });
		summary.health = await page.evaluate(
			async () => (await window.orbit.call("snapshot")).health,
		);
		await page.getByRole("button", { name: "Home", exact: true }).click();
		for (const name of ["Live source", "Live destination"]) {
			await page
				.getByRole("button", { name: "+ New project", exact: true })
				.click();
			await page.getByLabel("Project name *").fill(name);
			await page
				.getByRole("button", { name: "Create project", exact: true })
				.click();
			await expect(
				page.getByText(`Start a conversation in ${name}.`, { exact: true }),
			).toBeVisible({ timeout: 30000 });
		}
		await page
			.getByRole("button", { name: "Project Live source", exact: true })
			.click();
		await page.getByLabel("Model", { exact: true }).selectOption("gemma4:12b");
		const marker = "MAPLE-6382";
		await page
			.getByLabel("Task", { exact: true })
			.fill(
				`Remember the exact marker ${marker} for this conversation. Reply with only the marker. Do not use tools, commands, files, network or any external service.`,
			);
		await page.getByRole("button", { name: /(?:Run|Retry) task/ }).click();
		await expect(
			page.getByRole("button", { name: "Stop worker", exact: true }),
		).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("button", { name: /(?:Run|Retry) task/ }),
		).toBeVisible({ timeout: 90000 });
		let state = await page.evaluate(() => window.orbit.call("snapshot"));
		const source = state.projects.find((p: any) => p.name === "Live source");
		const sessionId = source.sessions[0].id;
		expect(source.sessions[0].status).toBe("completed");
		expect(source.sessions[0].answer).toContain(marker);
		expect(
			source.sessions[0].events.filter((e: any) => e.type === "approval"),
		).toHaveLength(0);
		summary.firstAnswer = source.sessions[0].answer;
		await page
			.getByLabel("Task", { exact: true })
			.fill(
				"Do not use tools, commands, files, network or external services. Write a long numbered list of 1000 distinct plain words, one per line.",
			);
		await page.getByRole("button", { name: /(?:Run|Retry) task/ }).click();
		let name = "";
		await expect
			.poll(
				async () => {
					const snapshot = await page.evaluate(() =>
						window.orbit.call("snapshot"),
					);
					name = snapshot.active?.containerName ?? "";
					if (!name) return "";
					return (
						await command(dockerPath, [
							"ps",
							"--filter",
							`name=^/${name}$`,
							"--format",
							"{{.Names}}",
						]).catch(() => "")
					).trim();
				},
				{ timeout: 15000 },
			)
			.not.toBe("");
		summary.cancelledContainer = name;
		await page
			.getByRole("button", { name: "Stop worker", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: /(?:Run|Retry) task/ }),
		).toBeVisible({ timeout: 15000 });
		state = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(state.active).toBeUndefined();
		expect(
			state.projects.find((p: any) => p.id === source.id).sessions[0].status,
		).toBe("cancelled");
		const cancelledSession = state.projects.find((p: any) => p.id === source.id)
			.sessions[0];
		const cancelledRequest = cancelledSession.events.filter(
			(event: any) => event.type === "submission",
		)[1].data.requestId;
		const intent = cancelledSession.events.find(
			(event: any) =>
				event.type === "cancel-requested" &&
				event.requestId === cancelledRequest,
		);
		expect(intent.data.effective).toBe(true);
		summary.cancelledDisplayStatus = cancelledSession.status;
		summary.rawCancelledOutcome = cancelledSession.events.findLast(
			(event: any) =>
				event.type === "result" && event.requestId === cancelledRequest,
		)?.data.runtime.outcome;
		await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
		expect(
			(
				await command(dockerPath, [
					"ps",
					"-a",
					"--filter",
					`name=^/${name}$`,
					"--format",
					"{{.Names}}",
				])
			).trim(),
		).toBe("");
		await page
			.getByLabel("Task", { exact: true })
			.fill(
				"Without using tools, commands, files, network or external services, reply with only READY.",
			);
		await page.getByRole("button", { name: /(?:Run|Retry) task/ }).click();
		await expect(
			page.getByRole("button", { name: "Stop worker", exact: true }),
		).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("button", { name: /(?:Run|Retry) task/ }),
		).toBeVisible({ timeout: 90000 });
		state = await page.evaluate(() => window.orbit.call("snapshot"));
		const retrySession = state.projects.find((p: any) => p.id === source.id)
			.sessions[0];
		expect(retrySession.status).toBe("completed");
		expect(retrySession.answer).toContain("READY");
		expect(
			retrySession.events.filter((e: any) => e.type === "submission"),
		).toHaveLength(3);
		expect(
			retrySession.events.filter((e: any) => e.type === "approval"),
		).toHaveLength(0);
		summary.retryAnswer = retrySession.answer;
		const originalWorkspace = retrySession.workspace;
		const originalCore = path.join(
			root,
			"projects",
			retrySession.storageProjectId,
			"core",
		);
		const originalFiles = await fs.readdir(
			path.join(originalCore, "sessions"),
			{ recursive: true },
		);
		await page
			.getByRole("button", {
				name: `Chat menu ${retrySession.name}`,
				exact: true,
			})
			.click();
		await page
			.getByRole("menuitem", { name: "Move to project", exact: true })
			.click();
		await page
			.getByLabel("Destination project")
			.selectOption({ label: "Live destination" });
		await page.getByRole("button", { name: "Move chat", exact: true }).click();
		state = await page.evaluate(() => window.orbit.call("snapshot"));
		const destination = state.projects.find(
			(p: any) => p.name === "Live destination",
		);
		expect(destination.sessions[0].id).toBe(sessionId);
		expect(destination.sessions[0].workspace).toBe(originalWorkspace);
		expect(destination.sessions[0].storageProjectId).toBe(source.id);
		expect(
			await fs.readdir(path.join(originalCore, "sessions"), {
				recursive: true,
			}),
		).toEqual(originalFiles);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page
			.getByRole("button", { name: retrySession.name, exact: true })
			.click();
		await page
			.getByLabel("Task", { exact: true })
			.fill(
				"From the first turn of this conversation, recall the exact marker I asked you to remember. Reply with only that marker. Do not use tools, commands, files, network or any external service.",
			);
		await page.getByRole("button", { name: /(?:Run|Retry) task/ }).click();
		await expect(
			page.getByRole("button", { name: "Stop worker", exact: true }),
		).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("button", { name: /(?:Run|Retry) task/ }),
		).toBeVisible({ timeout: 90000 });
		state = await page.evaluate(() => window.orbit.call("snapshot"));
		const resumed = state.projects.find((p: any) => p.id === destination.id)
			.sessions[0];
		expect(resumed.status).toBe("completed");
		expect(resumed.answer).toContain(marker);
		expect(
			resumed.events.filter((e: any) => e.type === "submission"),
		).toHaveLength(4);
		expect(
			resumed.events.filter((e: any) => e.type === "approval"),
		).toHaveLength(0);
		expect(resumed.workspace).toBe(originalWorkspace);
		expect(resumed.storageProjectId).toBe(source.id);
		summary.resumeAnswer = resumed.answer;
		summary.status = "passed";
		summary.historyFiles = originalFiles;
		summary.finishedAt = new Date().toISOString();
		await fs.mkdir("test-results", { recursive: true });
		await fs.writeFile(
			"test-results/live-approved.json",
			JSON.stringify(summary, null, 2),
		);
	} catch (error) {
		summary.status = "failed";
		summary.error = String(error);
		await fs.mkdir("test-results", { recursive: true });
		await fs.writeFile(
			"test-results/live-approved.json",
			JSON.stringify(summary, null, 2),
		);
		throw error;
	} finally {
		await app.close();
		await fs.rm(root, { recursive: true, force: true });
		summary.fixtureRemoved = true;
		await fs.writeFile(
			"test-results/live-approved.json",
			JSON.stringify(summary, null, 2),
		);
	}
});

test("live first-input title generation uses idle local model and preserves conversation through restart", async () => {
	test.skip(
		process.env.ORBIT_APP_LIVE !== "1",
		"Explicit local model verification only",
	);
	test.setTimeout(180000);
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-title-live-"));
	const launch = () =>
		electron.launch({
			args: ["."],
			env: { ...process.env, ORBIT_APP_TEST: "1", ORBIT_APP_DATA: root },
		});
	let app = await launch(),
		page = await app.firstWindow();
	try {
		const ids = await page.evaluate(async () => {
			const p = await window.orbit.call("create-project", {
				name: "Synthetic title verification",
			});
			const s = await window.orbit.call("create-session", { projectId: p.id });
			await window.orbit.call("select-model", {
				projectId: p.id,
				sessionId: s.id,
				model: "gemma4:12b",
			});
			return { p: p.id, s: s.id };
		});
		await page.getByRole("button", { name: "Chat 1", exact: true }).click();
		const prompt =
			"This chat concerns a Kyoto weekend itinerary. Reply with only OK. Do not use any tools, commands, files or external services.";
		await page.getByLabel("Task", { exact: true }).fill(prompt);
		await page.getByRole("button", { name: /Run task/ }).click();
		await expect(
			page.locator(".chat-status").getByText("Generating title…"),
		).toBeVisible({ timeout: 90000 });
		await page.screenshot({ path: "test-results/title-generating.png" });
		await expect
			.poll(
				async () => {
					const state = await page.evaluate(() =>
						window.orbit.call("snapshot"),
					);
					return state.projects.find((p: any) => p.id === ids.p).sessions[0]
						.autoTitle.stage;
				},
				{ timeout: 25000 },
			)
			.toBe("done");
		const state = await page.evaluate(() => window.orbit.call("snapshot")),
			session = state.projects.find((p: any) => p.id === ids.p).sessions[0];
		expect(session.name.length).toBeGreaterThan(0);
		expect(session.name.length).toBeLessThanOrEqual(80);
		expect(session.name).not.toBe(prompt.slice(0, 40));
		expect(session.answer).toContain("OK");
		expect(
			session.events.filter((e: any) => e.type === "submission"),
		).toHaveLength(1);
		expect(
			session.events.filter((e: any) => e.type === "approval"),
		).toHaveLength(0);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByRole("button", { name: session.name, exact: true }).click();
		const restored = await page.evaluate(() => window.orbit.call("snapshot"));
		expect(
			restored.projects.find((p: any) => p.id === ids.p).sessions[0].name,
		).toBe(session.name);
		await fs.writeFile(
			"test-results/title-live.json",
			JSON.stringify(
				{
					status: "passed",
					name: session.name,
					answer: session.answer,
					submissions: 1,
					model: "gemma4:12b",
				},
				null,
				2,
			),
		);
	} finally {
		await app.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

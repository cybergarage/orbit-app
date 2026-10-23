import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InitializationSettings } from "../src/initialization-settings";
import { initializationAvailability } from "../src/initialization";
import { Supervisor } from "../src/supervisor";
import { Store, assertAppProfileRoot } from "../src/store";
import {
	AppInitialization,
	assertExternalWritersStopped,
} from "../src/initialization-host";
import { ContainerCoreNames } from "../src/core-names";
import { containerMaintenance } from "../src/maintenance-container";

const consent = {
	confirmation: "INITIALIZE",
	allWritersStopped: true,
	automaticRestartersDisabled: true,
	exclusiveStorageControl: true,
};
async function fixture(t: any, project = true) {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-initialize-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const sup = new Supervisor(root, () => {});
	await sup.init();
	let p: any, s: any;
	if (project) {
		p = await sup.store.createProject("Synthetic project");
		s = await sup.store.createSession(p.id);
		await fs.writeFile(
			path.join(sup.store.workspace(p.id), "keep.txt"),
			"working artifact",
		);
		await fs.writeFile(
			path.join(sup.store.core(p.id), "unknown.txt"),
			"unknown owner",
		);
		sup.store.state.schedules.push({
			id: randomUUID(),
			projectId: p.id,
			sessionId: s.id,
			prompt: "Synthetic only",
			model: "fixture",
			nextAt: Date.now() + 3600000,
			intervalMs: 0,
			enabled: true,
		});
	}
	sup.store.state.appearance = "dark";
	sup.store.state.health = {
		docker: true,
		ollama: false,
		image: true,
		models: [],
		detail: [],
		checkedAt: 1,
	};
	await sup.store.save();
	await fs.writeFile(path.join(root, "cache", "unknown.txt"), "unknown cache");
	await fs.writeFile(path.join(root, "AGENTS.md"), "retained context");
	return { root, sup, p, s };
}
async function missing(file: string) {
	await assert.rejects(fs.access(file), { code: "ENOENT" });
}

test("initialization status is read-only, pinned local versions match and settings need explicit selection", async () => {
	const pkg = JSON.parse(
		await fs.readFile(
			new URL("../worker/package.json", import.meta.url),
			"utf8",
		),
	);
	const artifact = JSON.parse(
		await fs.readFile(
			new URL("../worker/packages/core-artifact.json", import.meta.url),
			"utf8",
		),
	);
	assert.equal(initializationAvailability.coreVersion, artifact.version);
	assert.equal(
		pkg.dependencies["@cybergarage/orbit"],
		`file:packages/${artifact.file}`,
	);
	const host = JSON.parse(
		await fs.readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
	);
	const worker = JSON.parse(
		await fs.readFile(
			new URL("../worker/package-lock.json", import.meta.url),
			"utf8",
		),
	);
	assert.equal(
		host.packages["node_modules/@cybergarage/orbit"].integrity,
		worker.packages["node_modules/@cybergarage/orbit"].integrity,
	);
	assert.equal(initializationAvailability.available, true);
	const supervisor = new Supervisor("/synthetic/unopened-profile", () => {
		throw Error("Unexpected publish");
	});
	const status = await supervisor.dispatch("initialization-status");
	assert.equal(status.available, true);
	assert.equal(status.maintenance, false);
	await assert.rejects(
		supervisor.dispatch("initialization-stop", {
			mode: "all",
			includeSettings: false,
		}),
		/explicitly include/,
	);
	assert.equal(
		(await supervisor.dispatch("initialization-status")).maintenance,
		false,
	);
	await assert.rejects(
		supervisor.dispatch("initialization-execute", { ...consent }),
		/Stop and verify/,
	);
	const html = renderToStaticMarkup(createElement(InitializationSettings));
	assert.match(html, /Reset settings/);
	assert.match(html, /Reset conversations, projects and schedules/);
	assert.match(html, /Reset all app settings, saved data and owned cache/);
	assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});

for (const mode of ["settings", "data", "all"] as const)
	test(`${mode} uses published plans, preserves working files and restarts without stale state`, async (t) => {
		const { root, sup, p, s } = await fixture(t);
		const names = new ContainerCoreNames(root);
		const catalog = path.join(root, "catalog");
		const pairId = randomUUID(),
			jobId = randomUUID();
		const mutate = (mutation: Record<string, unknown>) =>
			names.call(catalog, {
				command: "catalog-mutate",
				operationId: randomUUID(),
				mutation,
			});
		await mutate({
			kind: "membership",
			pairId,
			sessionId: s.id,
			projectId: p.id,
			expectedRevision: 0,
			unavailable: false,
		});
		await mutate({
			kind: "extraction",
			expectedRevision: 0,
			generation: 0,
			entries: [],
			job: {
				id: jobId,
				projectId: p.id,
				pairId,
				sessionId: s.id,
				runId: randomUUID(),
				membershipRevision: 1,
				sourceDigest: "a".repeat(64),
				messages: [
					{
						id: randomUUID(),
						role: "user",
						text: "Synthetic migration fixture",
						digest: "b".repeat(64),
					},
				],
				state: "pending",
				attempt: 0,
				revision: 0,
				inputTokens: 0,
				outputTokens: 0,
			},
		});
		await names.close();
		const before = await fs.readFile(Store.stateFile(root), "utf8");
		const preview = await sup.dispatch("initialization-preview", {
			mode,
			includeSettings: mode !== "data",
		});
		assert.equal(preview.final, false);
		assert.equal(await fs.readFile(Store.stateFile(root), "utf8"), before);
		assert.ok(
			preview.targets.every(
				(target: any) => !target.path.includes("/workspace"),
			),
		);
		assert.ok(
			preview.targets.every((target: any) =>
				target.path.startsWith(root + path.sep),
			),
		);
		const plan = await sup.dispatch("initialization-stop", {
			mode,
			includeSettings: mode !== "data",
		});
		assert.equal(plan.final, true);
		await assert.rejects(
			sup.dispatch("create-session", { projectId: p.id }),
			/writers are stopped/,
		);
		await sup.tick(Date.now() + 7200000);
		assert.equal(sup.store.state.executions?.length, 0);
		await assert.rejects(
			sup.dispatch("initialization-execute", { ...consent, planId: "wrong" }),
			/Final plan/,
		);
		await assert.rejects(
			sup.dispatch("initialization-execute", {
				...consent,
				planId: plan.id,
				exclusiveStorageControl: false,
			}),
			/every offline/,
		);
		assert.equal(await fs.readFile(Store.stateFile(root), "utf8"), before);
		const result = await sup.dispatch("initialization-execute", {
			...consent,
			planId: plan.id,
		});
		assert.equal(result.restartRequired, true);
		await sup.close();
		assert.equal(
			await fs.readFile(
				path.join(sup.store.workspace(p.id), "keep.txt"),
				"utf8",
			),
			"working artifact",
		);
		assert.equal(
			await fs.readFile(path.join(sup.store.core(p.id), "unknown.txt"), "utf8"),
			"unknown owner",
		);
		assert.equal(
			await fs.readFile(path.join(root, "cache", "unknown.txt"), "utf8"),
			"unknown cache",
		);
		assert.equal(
			await fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
			"retained context",
		);
		const restarted = new Supervisor(root, () => {});
		await restarted.init();
		assert.equal(
			(await restarted.dispatch("initialization-status")).maintenance,
			false,
		);
		assert.equal(
			restarted.store.state.appearance,
			mode === "data" ? "dark" : "system",
		);
		if (mode === "settings") {
			assert.equal(restarted.store.session(p.id, s.id).name, s.name);
			assert.equal(restarted.store.state.schedules.length, 1);
			const retained = new ContainerCoreNames(root);
			try {
				assert.equal(
					(
						await retained.call(catalog, {
							command: "catalog-query",
							query: { kind: "extraction", id: jobId },
						})
					).state,
					"pending",
				);
			} finally {
				await retained.close();
			}
		} else {
			assert.equal(restarted.store.state.projects.length, 0);
			assert.equal(restarted.store.state.schedules.length, 0);
			await missing(path.join(sup.store.core(p.id), "sessions"));
			await missing(path.join(catalog, "projects.sqlite"));
			const fresh = await restarted.store.createProject("Fresh after reset");
			await restarted.store.createSession(fresh.id);
		}
		if (mode === "all") await missing(path.join(root, "cache", "health.json"));
		else
			assert.ok(
				await fs.readFile(path.join(root, "cache", "health.json"), "utf8"),
			);
		await restarted.close();
	});

test("changed final targets refuse deletion and interrupted maintenance survives restart", async (t) => {
	const { root, sup } = await fixture(t, false);
	const plan = await sup.dispatch("initialization-stop", {
		mode: "all",
		includeSettings: true,
	});
	await fs.writeFile(
		path.join(root, "settings.json"),
		JSON.stringify({ appearance: "light" }),
	);
	await assert.rejects(
		sup.dispatch("initialization-execute", { ...consent, planId: plan.id }),
		/targets changed/,
	);
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	await sup.close();
	const resumed = new Supervisor(root, () => {});
	await resumed.init();
	assert.equal(
		(await resumed.dispatch("initialization-status")).maintenance,
		true,
	);
	await assert.rejects(
		resumed.dispatch("appearance", { value: "dark" }),
		/writers are stopped/,
	);
	const remaining = await resumed.dispatch("initialization-stop", {
		mode: "all",
		includeSettings: true,
	});
	await resumed.dispatch("initialization-execute", {
		...consent,
		planId: remaining.id,
	});
	await resumed.close();
	await missing(Store.stateFile(root));
});

test("unknown registry, settings, symlinks and external shutdown refusal fail closed", async (t) => {
	const { root, sup } = await fixture(t, false);
	await fs.writeFile(
		path.join(root, "registry", "plugin-data.json"),
		"unknown",
	);
	await assert.rejects(
		sup.dispatch("initialization-preview", { mode: "data" }),
		/Unknown object retained/,
	);
	await fs.unlink(path.join(root, "registry", "plugin-data.json"));
	await fs.writeFile(
		path.join(root, "settings.json"),
		JSON.stringify({ appearance: "dark", secretExtension: "synthetic" }),
	);
	await assert.rejects(
		sup.dispatch("initialization-preview", {
			mode: "settings",
			includeSettings: true,
		}),
		/Unknown settings fields/,
	);
	await fs.writeFile(
		path.join(root, "settings.json"),
		JSON.stringify({ appearance: "dark" }),
	);
	await fs.unlink(path.join(root, "cache", "health.json"));
	await fs.symlink(
		path.join(root, "AGENTS.md"),
		path.join(root, "cache", "health.json"),
	);
	await assert.rejects(
		sup.dispatch("initialization-preview", {
			mode: "all",
			includeSettings: true,
		}),
		/Unsafe initialization path/,
	);
	await fs.unlink(path.join(root, "cache", "health.json"));
	const stopped = new AppInitialization(
		sup.store,
		containerMaintenance,
		async () => {
			throw new Error("Synthetic external writer still open");
		},
	);
	await assert.rejects(stopped.review("data", false), /external writer/);
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	await sup.close();
});

test("known core writer evidence blocks final review without metadata rewriting or deletion", async (t) => {
	const { root, sup, p, s } = await fixture(t);
	const owner = path.join(
		sup.store.core(p.id),
		"sessions",
		".coordination",
		`${s.id}.guard`,
	);
	await fs.mkdir(path.dirname(owner), { recursive: true });
	await fs.writeFile(
		owner,
		JSON.stringify({ version: 1, pid: 999999, token: "synthetic" }),
	);
	await assert.rejects(
		sup.dispatch("initialization-stop", {
			mode: "data",
			includeSettings: false,
		}),
	);
	assert.ok(await fs.readFile(owner, "utf8"));
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	await sup.close();
});

test("partial per-store failure lists completed paths, preserves registry and stays offline", async (t) => {
	const { root, sup, p } = await fixture(t);
	const second = await sup.store.createProject("Second fixture");
	await sup.store.createSession(second.id);
	await sup.close();
	const store = new Store(root);
	await store.init();
	await store.close();
	const order: string[] = [];
	let executions = 0;
	const adapter = new AppInitialization(
		store,
		async (core, request) => {
			if (request.action === "execute" && ++executions === 2)
				throw new Error("Synthetic second-store failure");
			if (request.action === "execute") order.push(core);
			return containerMaintenance(core, request);
		},
		async () => {},
	);
	const plan = await adapter.review("data", false);
	await assert.rejects(
		adapter.execute({ ...consent, planId: plan.id }),
		/Completed paths: .*Synthetic second-store failure/,
	);
	assert.equal(order.length, 1);
	await missing(path.join(order[0], "sessions"));
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	assert.ok(
		await fs.readFile(
			path.join(root, "initialization-maintenance.json"),
			"utf8",
		),
	);
	assert.ok(await fs.stat(sup.store.workspace(p.id)));
	const resumed = new Supervisor(root, () => {});
	await resumed.init();
	assert.equal(
		(await resumed.dispatch("initialization-status")).maintenance,
		true,
	);
	await assert.rejects(
		resumed.dispatch("initialization-stop", {
			mode: "settings",
			includeSettings: true,
		}),
		/scope cannot be narrowed/,
	);
	const pending = JSON.parse(
		await fs.readFile(
			path.join(root, "initialization-maintenance.json"),
			"utf8",
		),
	);
	assert.equal(pending.mode, "data");
	assert.equal(pending.includeSettings, false);
	await assert.rejects(fs.access(path.join(order[0], "sessions")), {
		code: "ENOENT",
	});
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	const remaining = await resumed.dispatch("initialization-stop", {
		mode: "data",
	});
	await resumed.dispatch("initialization-execute", {
		...consent,
		planId: remaining.id,
	});
	await resumed.close();
	const restarted = new Supervisor(root, () => {});
	await restarted.init();
	assert.equal(restarted.store.state.projects.length, 0);
	await restarted.close();
});

test("legacy mixed state is moved and split without a copy; settings reset cannot delete data fields", async (t) => {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-init-upgrade-")),
	);
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const legacy = path.join(root, "state.json");
	await fs.writeFile(
		legacy,
		JSON.stringify({
			namesVersion: 1,
			projects: [],
			schedules: [],
			appearance: "dark",
			submissionSequence: 42,
			health: {
				docker: false,
				ollama: false,
				image: false,
				models: [],
				detail: [],
			},
		}),
	);
	const original = (await fs.stat(legacy)).ino;
	const store = new Store(root);
	await store.init();
	await missing(legacy);
	assert.ok(original > 0);
	const saved = JSON.parse(await fs.readFile(Store.stateFile(root), "utf8"));
	assert.equal(saved.submissionSequence, 42);
	assert.equal(saved.appearance, undefined);
	assert.equal(saved.health, undefined);
	assert.equal(
		JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8"))
			.appearance,
		"dark",
	);
	await store.close();
});

test("writable host handles refuse final review without stopping foreign processes", async (t) => {
	const { root, sup } = await fixture(t, false);
	const handle = await fs.open(Store.stateFile(root), "r+");
	try {
		await assert.rejects(
			sup.dispatch("initialization-stop", { mode: "data" }),
			/Open storage handles remain/,
		);
		assert.ok(await handle.stat());
		assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	} finally {
		await handle.close();
		await sup.close();
	}
});

test("active and restart-enabled foreign containers refuse maintenance", async (t) => {
	const { root, sup } = await fixture(t, false);
	const { command, dockerPath, image, workerUserArgs } = await import(
		"../src/worker"
	);
	const name = `orbit-initialize-foreign-${randomUUID()}`;
	await command(dockerPath, [
		"run",
		"-d",
		"--rm",
		"--pull=never",
		"--name",
		name,
		"--network",
		"none",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--mount",
		`type=bind,src=${root},dst=/synthetic,readonly`,
		...workerUserArgs(),
		"--entrypoint",
		"node",
		image,
		"-e",
		"setInterval(()=>{},1000)",
	]);
	try {
		await assert.rejects(
			sup.dispatch("initialization-stop", { mode: "data" }),
			/container writer or automatic restarter/,
		);
		assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	} finally {
		await command(dockerPath, ["rm", "-f", name]);
		await sup.close();
	}
});

test("background titles are aborted and awaited before final planning", async (t) => {
	const { root, sup, p, s } = await fixture(t);
	const { AutoTitles } = await import("../src/auto-titles");
	let started = false,
		aborted = false,
		ended = false;
	const titles = new AutoTitles(
		sup.store,
		() => true,
		() => sup.publish(),
		async (_prompt, _model, signal) => {
			started = true;
			return new Promise((_, reject) =>
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						ended = true;
						reject(new Error("Synthetic title aborted"));
					},
					{ once: true },
				),
			);
		},
	);
	await titles.provision(p.id, s, "Synthetic title", "fixture");
	titles.kick();
	for (let i = 0; i < 1000 && !started; i++)
		await new Promise((r) => setTimeout(r, 2));
	assert.equal(started, true);
	// Inject a title dependency, not a production bypass or a provider request.
	Object.defineProperty(sup, "titles", { value: titles });
	const plan = await sup.dispatch("initialization-stop", {
		mode: "settings",
		includeSettings: true,
	});
	assert.equal(plan.final, true);
	assert.equal(aborted, true);
	assert.equal(ended, true);
	const before = await fs.readFile(Store.stateFile(root), "utf8");
	titles.kick();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(await fs.readFile(Store.stateFile(root), "utf8"), before);
	await sup.close();
});

test("worker stop and cleanup are awaited, and uncertain cleanup prevents a final plan", async (t) => {
	for (const refuse of [false, true]) {
		const { root, sup: original, p, s } = await fixture(t);
		await original.close();
		let finish!: () => void,
			stopped = false,
			verified = false;
		const sup = new Supervisor(
			root,
			() => {},
			(_workspace, _core, _config, _event) =>
				({
					name: `fixture-${randomUUID()}`,
					start: () =>
						new Promise<void>((resolve) => {
							finish = resolve;
						}),
					stop: async () => {
						stopped = true;
						finish();
					},
					confirmGone: async () => {
						if (refuse) throw new Error("Synthetic cleanup uncertainty");
						verified = true;
					},
				}) as any,
		);
		await sup.init();
		sup.health = async () => ({
			docker: true,
			ollama: true,
			image: true,
			models: ["fixture"],
			detail: [],
		});
		await sup.dispatch("submit", {
			projectId: p.id,
			sessionId: s.id,
			requestId: randomUUID(),
			prompt: "Synthetic only",
			model: "fixture",
		});
		const review = sup.dispatch("initialization-stop", { mode: "data" });
		if (refuse) await assert.rejects(review, /shutdown is not confirmed/);
		else {
			const plan = await review;
			assert.equal(plan.final, true);
			assert.equal(verified, true);
		}
		assert.equal(stopped, true);
		assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
		await sup.close();
	}
});

test("initialization cancels admission during preflight and prevents delayed Worker start", async (t) => {
	const { root, sup: original } = await fixture(t, false);
	await original.close();
	const { orderFixture, seedOrderFixture } = await import("./fixtures/order");
	const f = orderFixture(root, () => {});
	f.sup.store.state = seedOrderFixture();
	await f.sup.store.save();
	const p = f.sup.store.state.projects[0],
		s = p.sessions[0];
	const submission = f.sup.dispatch("submit", {
		projectId: p.id,
		sessionId: s.id,
		requestId: randomUUID(),
		prompt: "Synthetic delayed admission",
		model: "fixture",
	});
	const rejected = assert.rejects(submission, /Submission cancelled/);
	for (let i = 0; i < 1000 && !f.healthReady(); i++)
		await new Promise((r) => setTimeout(r, 2));
	assert.equal(f.healthReady(), true);
	const review = f.sup.dispatch("initialization-stop", { mode: "data" });
	f.release();
	await rejected;
	assert.equal((await review).final, true);
	assert.equal(f.starts(), 0);
	await f.sup.close();
});

test("malformed metadata never echoes content and unsafe control records stay untouched", async (t) => {
	const { root, sup } = await fixture(t, false);
	await fs.writeFile(
		path.join(root, "settings.json"),
		"SYNTHETIC_CONTENT_MUST_NOT_APPEAR",
	);
	await assert.rejects(
		sup.dispatch("initialization-preview", {
			mode: "settings",
			includeSettings: true,
		}),
		(error: any) =>
			!error.message.includes("SYNTHETIC_CONTENT_MUST_NOT_APPEAR") &&
			/Invalid App JSON/.test(error.message),
	);
	await fs.writeFile(
		path.join(root, "settings.json"),
		JSON.stringify({ appearance: "dark" }),
	);
	const retained = path.join(root, "retained.txt");
	await fs.writeFile(retained, "Retain control target");
	await fs.symlink(
		retained,
		path.join(root, "initialization-maintenance.json"),
	);
	await assert.rejects(
		sup.dispatch("initialization-stop", { mode: "data" }),
		/Unsafe maintenance record/,
	);
	assert.equal(await fs.readFile(retained, "utf8"), "Retain control target");
	assert.equal(
		(
			await fs.lstat(path.join(root, "initialization-maintenance.json"))
		).isSymbolicLink(),
		true,
	);
	await sup.close();
});

test("stopped foreign container with restart policy also refuses final review", async (t) => {
	const { root, sup } = await fixture(t, false);
	const { command, dockerPath, image } = await import("../src/worker");
	const name = `orbit-initialize-restarter-${randomUUID()}`;
	await command(dockerPath, [
		"create",
		"--name",
		name,
		"--restart=always",
		"--network",
		"none",
		"--mount",
		`type=bind,src=${root},dst=/synthetic,readonly`,
		"--entrypoint",
		"node",
		image,
		"-e",
		"setInterval(()=>{},1000)",
	]);
	try {
		await assert.rejects(
			sup.dispatch("initialization-stop", { mode: "data" }),
			/container writer or automatic restarter/,
		);
		assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	} finally {
		await command(dockerPath, ["rm", "-f", name]);
		await sup.close();
	}
});

test("dedicated App root validation refuses shared CLI roots and aliases using synthetic homes", async (t) => {
	const syntheticHome = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "orbit-synthetic-home-")),
	);
	t.after(() => fs.rm(syntheticHome, { recursive: true, force: true }));
	const shared = path.join(syntheticHome, ".orbit");
	await fs.mkdir(shared);
	const alias = path.join(syntheticHome, "alias");
	await fs.symlink(shared, alias);
	await assert.rejects(
		assertAppProfileRoot(shared, syntheticHome),
		/Shared CLI\/GUI/,
	);
	await assert.rejects(
		assertAppProfileRoot(path.join(shared, "child"), syntheticHome),
		/Shared CLI\/GUI/,
	);
	await assert.rejects(
		assertAppProfileRoot(alias, syntheticHome),
		/Shared CLI\/GUI/,
	);
	await assertAppProfileRoot(
		path.join(syntheticHome, "dedicated-app"),
		syntheticHome,
	);
	assert.deepEqual(await fs.readdir(shared), []);
});

test("a saved workspace overlapping a core target refuses deletion", async (t) => {
	const { root, sup, p, s } = await fixture(t);
	const workspace = path.join(
		sup.store.core(p.id),
		"sessions",
		"retained-workspace",
	);
	await fs.mkdir(workspace);
	await fs.writeFile(
		path.join(workspace, "keep.txt"),
		"Retain even inside a selected store",
	);
	s.workspace = workspace;
	await sup.store.save();
	await assert.rejects(
		sup.dispatch("initialization-preview", { mode: "data" }),
		/Working files overlap/,
	);
	assert.equal(
		await fs.readFile(path.join(workspace, "keep.txt"), "utf8"),
		"Retain even inside a selected store",
	);
	assert.ok(await fs.readFile(Store.stateFile(root), "utf8"));
	await sup.close();
});

test("container inventory disappearance needs successful fresh absence confirmation", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-inspection-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	for (const outcome of ["absent", "present", "unavailable", "other-error"]) {
		const calls: string[][] = [];
		const inspect = async (_exe: string, args: string[]) => {
			calls.push(args);
			if (calls.length === 1) return "a".repeat(64);
			if (calls.length === 2)
				throw new Error(
					outcome === "other-error" ? "daemon unavailable" : "no such object",
				);
			if (outcome === "unavailable") throw new Error("daemon unavailable");
			return outcome === "present" ? "a".repeat(64) : "";
		};
		const result = assertExternalWritersStopped(root, [], inspect);
		if (outcome === "absent") await result;
		else await assert.rejects(result);
		assert.equal(calls.length, outcome === "other-error" ? 2 : 3);
		if (calls.length === 3)
			assert.deepEqual(calls[2], [
				"ps",
				"-aq",
				"--no-trunc",
				"--filter",
				`id=${"a".repeat(64)}`,
			]);
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InitializationSettings } from "../src/initialization-settings";
import { initializationAvailability } from "../src/initialization";
import { Supervisor } from "../src/supervisor";

test("initialization preparation is read-only and remains gated on the Electron adapter", async () => {
	const pkg = JSON.parse(
		await fs.readFile(
			new URL("../worker/package.json", import.meta.url),
			"utf8",
		),
	);
	assert.equal(
		initializationAvailability.coreVersion,
		pkg.dependencies["@cybergarage/orbit"],
	);
	const supervisor = new Supervisor("/synthetic/unopened-profile", () => {
		throw Error("Unexpected publish");
	});
	const before = structuredClone(supervisor.store.state);
	assert.deepEqual(await supervisor.dispatch("initialization-status"), {
		...initializationAvailability,
		root: "/synthetic/unopened-profile",
	});
	assert.deepEqual(supervisor.store.state, before);
	await assert.rejects(
		supervisor.dispatch("initialize", {
			mode: "all",
			confirmation: "INITIALIZE",
		}),
	);
});
test("all three initialization scopes are visible but destructive actions are disabled", () => {
	const html = renderToStaticMarkup(createElement(InitializationSettings));
	for (const label of [
		"Reset settings",
		"Reset conversations, projects and schedules",
		"Reset all app settings, saved data and owned cache",
		"core 0.9.3",
		"No reset or backup",
		"external workspaces",
	])
		assert.ok(html.includes(label));
	assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});

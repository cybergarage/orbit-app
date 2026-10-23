import { test } from "node:test";
import assert from "node:assert/strict";
import { ContainerCoreNames } from "../src/core-names";

test("Store and knowledge metadata clients serialize one profile, recover from failure and close independently", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const events: string[] = [];
	class Client extends ContainerCoreNames {
		protected async performCall(
			_core: string,
			request: Record<string, unknown>,
		) {
			const id = String(request.id);
			events.push(id);
			if (id === "store") await blocked;
			if (id === "failure") throw new Error("synthetic metadata failure");
			return id;
		}
	}
	const store = new Client("/synthetic/profile"),
		knowledge = new Client("/synthetic/profile/"),
		other = new Client("/synthetic/other");
	const first = store.call("core", { id: "store" });
	const queued = knowledge.call("catalog", { id: "knowledge" });
	const close = store.close();
	await assert.rejects(store.call("core", { id: "late" }), /closed/);
	assert.equal(await other.call("core", { id: "other" }), "other");
	assert.deepEqual(events, ["store", "other"]);
	release();
	await Promise.all([first, queued, close]);
	assert.deepEqual(events, ["store", "other", "knowledge"]);
	await assert.rejects(
		knowledge.call("catalog", { id: "failure" }),
		/synthetic/,
	);
	assert.equal(
		await knowledge.call("catalog", { id: "after-failure" }),
		"after-failure",
	);
	await knowledge.close();
	await other.close();
});

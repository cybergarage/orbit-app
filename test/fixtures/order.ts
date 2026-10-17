import { randomUUID } from "node:crypto";
import { Supervisor } from "../../src/supervisor";
import type { Snapshot } from "../../src/types";
import type { Worker } from "../../src/worker";

export function orderFixture(root: string, changed: (s: Snapshot) => void) {
	let releaseHealth = () => {};
	let finish = () => {};
	let starts = 0;
	let healthReady = false;
	const sup = new Supervisor(
		root,
		changed,
		(_workspace, _core, _config, event) =>
			({
				name: "fixture-worker",
				start: () => {
					starts++;
					return new Promise<void>((resolve) => {
						finish = () => {
							event({
								type: "result",
								data: {
									answer: "Fixture answer",
									runtime: { outcome: "completed" },
								},
							});
							resolve();
						};
					});
				},
				stop: async () => finish(),
				confirmGone: async () => {},
			}) as unknown as Worker,
	);
	sup.store.refreshNames = async () => {
		for (const p of sup.store.state.projects) {
			p.name = p.unassigned ? "Chats" : "Project";
			for (const [index, s] of p.sessions.entries())
				s.name = `${p.name} ${index + 1}`;
		}
	};
	sup.health = () =>
		new Promise((resolve) => {
			healthReady = true;
			releaseHealth = () =>
				resolve({
					docker: true,
					ollama: true,
					image: true,
					models: ["fixture"],
					detail: [],
				});
		});
	sup.store.executionWorkspace = async () => root;
	return {
		sup,
		release: () => {
			healthReady = false;
			releaseHealth();
		},
		healthReady: () => healthReady,
		finish: () => finish(),
		starts: () => starts,
	};
}
export function seedOrderFixture(): Snapshot {
	return {
		namesVersion: 1,
		health: {
			docker: true,
			ollama: true,
			image: true,
			models: ["fixture"],
			detail: [],
		},
		schedules: [],
		projects: [false, true].map((unassigned) => ({
			id: randomUUID(),
			name: unassigned ? "Chats" : "Project",
			unassigned,
			sessions: [1, 2].map((n) => ({
				id: randomUUID(),
				name: `${unassigned ? "Chats" : "Project"} ${n}`,
				status: "idle",
				events: [],
			})),
		})),
	};
}

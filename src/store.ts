import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Snapshot, Project, DesktopSession } from "./types";
export function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
		throw Error("Invalid identifier");
	return value;
}
export function text(value: unknown, max = 12000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw Error("Invalid text");
	return value.trim();
}
export class Store {
	state: Snapshot = { projects: [], schedules: [] };
	private writes = Promise.resolve();
	constructor(readonly root: string) {}
	async init() {
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		try {
			this.state = JSON.parse(
				await fs.readFile(path.join(this.root, "state.json"), "utf8"),
			);
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
		}
		for (const p of this.state.projects)
			for (const s of p.sessions)
				if (
					["running", "awaiting-approval", "starting", "cancelling"].includes(
						s.status,
					)
				) {
					s.status = "interrupted";
					s.events.push({
						id: randomUUID(),
						type: "interrupted",
						at: new Date().toISOString(),
						data: "App exited before completion. Inspect history before submitting again.",
					});
				}

		await this.save();
	}
	async save() {
		const data = JSON.stringify(this.state);
		this.writes = this.writes.then(async () => {
			const file = path.join(this.root, "state.json");
			await fs.writeFile(`${file}.tmp`, data, { mode: 0o600 });
			await fs.rename(`${file}.tmp`, file);
		});
		await this.writes;
	}
	project(id: unknown): Project {
		const p = this.state.projects.find((p) => p.id === identifier(id));
		if (!p) throw Error("Project not found");
		return p;
	}
	session(projectId: unknown, sessionId: unknown): DesktopSession {
		const s = this.project(projectId).sessions.find(
			(s) => s.id === identifier(sessionId),
		);
		if (!s) throw Error("Session not found");
		return s;
	}
	async createProject(name: unknown) {
		const p: Project = { id: randomUUID(), name: text(name, 80), sessions: [] };
		this.state.projects.push(p);
		await fs.mkdir(this.workspace(p.id), { recursive: true, mode: 0o700 });
		await fs.mkdir(this.core(p.id), { recursive: true, mode: 0o700 });
		await this.save();
		return p;
	}
	async createSession(projectId: unknown) {
		const p = this.project(projectId);
		const s: DesktopSession = {
			id: randomUUID(),
			name: `Session ${p.sessions.length + 1}`,
			events: [],
			status: "idle",
		};
		p.sessions.push(s);
		await this.save();
		return s;
	}
	workspace(id: string) {
		return path.join(this.root, "projects", identifier(id), "workspace");
	}
	core(id: string) {
		return path.join(this.root, "projects", identifier(id), "core");
	}
}

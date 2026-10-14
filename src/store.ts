import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Snapshot, Project, DesktopSession } from "./types";
export function identifier(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
		throw new Error("Invalid identifier");
	return value;
}
export function text(value: unknown, max = 12000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new Error("Invalid text");
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
		await fs
			.copyFile(
				path.join(this.root, "state.json"),
				path.join(this.root, "state.pre-approved-ui.json"),
				fs.constants.COPYFILE_EXCL,
			)
			.catch((e) => {
				if (!["ENOENT", "EEXIST"].includes(e.code)) throw e;
			});
		this.state.executions ??= [];
		for (const run of this.state.executions)
			if (!run.endedAt) {
				run.status = "interrupted";
				run.endedAt = Date.now();
				run.events.push({
					id: randomUUID(),
					type: "interrupted",
					at: new Date().toISOString(),
					data: "App exited before completion; this occurrence will not be replayed.",
				});
			}
		for (const p of this.state.projects)
			for (const s of p.sessions) {
				s.storageProjectId ??= p.id;
				s.workspace ??= this.workspace(p.id);
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
		if (!p) throw new Error("Project not found");
		return p;
	}
	session(projectId: unknown, sessionId: unknown): DesktopSession {
		const s = this.project(projectId).sessions.find(
			(s) => s.id === identifier(sessionId),
		);
		if (!s) throw new Error("Session not found");
		return s;
	}
	async createProject(
		name: unknown,
		directory?: unknown,
		instructions?: unknown,
		unassigned = false,
	) {
		const p: Project = {
			id: randomUUID(),
			name: text(name, 80),
			directory: await this.directory(directory),
			instructions: this.instructions(instructions),
			unassigned,
			sessions: [],
		};
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
			storageProjectId: p.id,
			workspace: p.directory ?? this.workspace(p.id),
		};
		p.sessions.push(s);
		await this.save();
		return s;
	}
	async directory(value: unknown): Promise<string | undefined> {
		if (value === undefined || value === "") return undefined;
		const input = text(value, 4096);
		if (!path.isAbsolute(input) || /[,\n\r]/.test(input))
			throw new Error(
				"Use an absolute local directory without commas or newlines",
			);
		const resolved = await fs.realpath(input);
		if (/[,\n\r]/.test(resolved))
			throw new Error(
				"Canonical working directory must not contain commas or newlines",
			);
		const home = await fs.realpath(os.homedir());
		const temporary = await fs.realpath(os.tmpdir());
		if (
			(!resolved.startsWith(`${home}${path.sep}`) &&
				!resolved.startsWith(`${temporary}${path.sep}`)) ||
			["/", home].includes(resolved) ||
			resolved
				.split(path.sep)
				.some((part) =>
					[
						".ssh",
						".aws",
						".docker",
						".config",
						".codex",
						".ollama",
						"Library",
					].includes(part),
				)
		)
			throw new Error(
				"Home, system and credential directories cannot be worker workspaces",
			);
		const anchor = resolved.startsWith(`${home}${path.sep}`) ? home : temporary;
		await this.assertPrivateDirectoryTree(resolved, anchor);
		return resolved;
	}
	private async assertPrivateDirectoryTree(directory: string, anchor: string) {
		const uid = process.getuid?.();
		if (uid === undefined)
			throw new Error(
				"Directory ownership validation is unavailable on this platform",
			);
		const anchorStat = await fs.lstat(anchor);
		if ((anchorStat.mode & 0o022) !== 0 && (anchorStat.mode & 0o1000) === 0)
			throw new Error(
				"Working directory anchor must not allow shared writes without sticky protection",
			);
		const entries: string[] = [];
		for (
			let current = directory;
			current !== anchor;
			current = path.dirname(current)
		)
			entries.push(current);
		const stats = await Promise.all(entries.map((entry) => fs.lstat(entry)));
		for (const stat of stats) {
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("Working directory must remain an existing directory");
			if (stat.uid !== uid || (stat.mode & 0o022) !== 0)
				throw new Error(
					"Working directory and its parents must be user-owned and not group/world writable",
				);
		}
	}
	async executionWorkspace(projectId: unknown, sessionId: unknown) {
		const session = this.session(projectId, sessionId);
		const location = this.location(projectId, sessionId);
		const managed = this.workspace(
			session.storageProjectId ?? this.project(projectId).id,
		);
		if (location.workspace === managed) {
			await this.assertPrivateDirectoryTree(
				await fs.realpath(managed),
				await fs.realpath(this.root),
			);
			return location.workspace;
		}
		const canonical = await this.directory(location.workspace);
		if (canonical !== location.workspace)
			throw new Error(
				"Working directory identity changed; inspect this session before running",
			);
		return canonical;
	}
	instructions(value: unknown) {
		return value === undefined || value === "" ? undefined : text(value);
	}
	assertMovable(projectId: unknown, sessionId: unknown) {
		const s = this.session(projectId, sessionId);
		if (
			this.state.active?.sessionId === s.id ||
			[
				"running",
				"starting",
				"awaiting-approval",
				"cancelling",
				"recovery-blocked",
			].includes(s.status)
		)
			throw new Error(
				"Running or recovery-pending sessions cannot be moved or renamed",
			);
		return s;
	}
	async editProject(p: any) {
		const project = this.project(p.projectId);
		const directory = await this.directory(p.directory);
		const name = text(p.name, 80),
			instructions = this.instructions(p.instructions);
		Object.assign(project, { name, directory, instructions });
		await this.save();
		return project;
	}
	async renameSession(p: any) {
		const s = this.session(p.projectId, p.sessionId);
		s.name = text(p.name, 80);
		await this.save();
		return s;
	}
	async moveSession(p: any) {
		const source = this.project(p.projectId),
			target = this.project(p.targetProjectId);
		const s = this.assertMovable(source.id, p.sessionId);
		if (source.id === target.id) return s;
		s.storageProjectId ??= source.id;
		s.workspace ??= this.workspace(source.id);
		source.sessions = source.sessions.filter((item) => item !== s);
		target.sessions.push(s);
		for (const schedule of this.state.schedules)
			if (schedule.sessionId === s.id) schedule.projectId = target.id;
		await this.save();
		return s;
	}
	async chats() {
		return (
			this.state.projects.find((p) => p.unassigned) ??
			this.createProject("Chats", undefined, undefined, true)
		);
	}
	location(projectId: unknown, sessionId: unknown) {
		const s = this.session(projectId, sessionId);
		return {
			workspace: s.workspace ?? this.workspace(this.project(projectId).id),
			core: this.core(s.storageProjectId ?? this.project(projectId).id),
		};
	}
	workspace(id: string) {
		return path.join(this.root, "projects", identifier(id), "workspace");
	}
	core(id: string) {
		return path.join(this.root, "projects", identifier(id), "core");
	}
}

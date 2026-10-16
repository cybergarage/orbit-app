import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Snapshot, Project, DesktopSession } from "./types";
import { ContainerCoreNames, type CoreNames } from "./core-names";
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
	constructor(
		readonly root: string,
		private readonly names: CoreNames = new ContainerCoreNames(root),
	) {}
	async init() {
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		try {
			this.state = JSON.parse(
				await fs.readFile(path.join(this.root, "state.json"), "utf8"),
			);
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
		}

		if (this.state.projects.length && this.state.namesVersion !== 1)
			throw new Error(
				`Legacy App names are unsupported at ${this.root}. Existing data was not changed. Use a fresh data directory after explicitly handling the old data.`,
			);
		await this.refreshNames();
		this.state.namesVersion = 1;
		this.state.executions ??= [];
		this.restoreRuntimeState();

		await this.save();
	}
	private restoreRuntimeState() {
		for (const run of this.state.executions ?? [])
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
	}

	async save() {
		const data = JSON.stringify({
			...this.state,
			namesVersion: 1,
			projects: this.state.projects.map((project) => {
				const {
					name: _name,
					nameRevision: _revision,
					sessions,
					...metadata
				} = project;
				return {
					...metadata,
					sessions: sessions.map(
						({ name: _title, nameRevision: _titleRevision, ...session }) =>
							session,
					),
				};
			}),
		});
		this.writes = this.writes.then(async () => {
			const file = path.join(this.root, "state.json");
			await fs.writeFile(`${file}.tmp`, data, { mode: 0o600 });
			await fs.rename(`${file}.tmp`, file);
		});
		await this.writes;
	}
	async refreshNames() {
		// Serialize readers: opening one container per project concurrently is unbounded.
		await this.state.projects.reduce(
			(previous, project) =>
				previous.then(() => this.refreshProjectNames(project)),
			Promise.resolve(),
		);
	}
	private async refreshProjectNames(project: Project) {
		const named = await this.names.call(this.core(project.id), {
			command: "read-project",
			projectId: project.id,
		});
		if (named.revision >= (project.nameRevision ?? 0)) {
			project.name = named.name;
			project.nameRevision = named.revision;
		}
		const groups = new Map<string, DesktopSession[]>();
		for (const session of project.sessions) {
			const original = session.storageProjectId ?? project.id;
			groups.set(original, [...(groups.get(original) ?? []), session]);
		}
		await [...groups].reduce(
			(previous, [original, sessions]) =>
				previous.then(() => this.refreshSessionNames(original, sessions)),
			Promise.resolve(),
		);
	}
	private async refreshSessionNames(
		original: string,
		sessions: DesktopSession[],
	) {
		const titles = await this.names.call(this.core(original), {
			command: "read-sessions",
			sessionIds: sessions.map((session) => session.id),
		});
		for (const session of sessions) {
			const title = titles.find((item: any) => item.id === session.id);
			if (!title) throw new Error("Missing core session title");
			if (title.revision >= (session.nameRevision ?? 0)) {
				session.name = title.name;
				session.nameRevision = title.revision;
			}
		}
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
		await fs.mkdir(this.workspace(p.id), { recursive: true, mode: 0o700 });
		await fs.mkdir(this.core(p.id), { recursive: true, mode: 0o700 });
		const named = await this.names.call(this.core(p.id), {
			command: "create-project",
			projectId: p.id,
			name: p.name,
		});
		p.name = named.name;
		p.nameRevision = named.revision;
		this.state.projects.push(p);
		await this.save();
		return p;
	}
	async createSession(projectId: unknown) {
		const p = this.project(projectId);
		const s: DesktopSession = {
			id: randomUUID(),
			name: `Chat ${p.sessions.length + 1}`,
			events: [],
			status: "idle",
			storageProjectId: p.id,
			workspace: p.directory ?? this.workspace(p.id),
		};
		await this.names.call(this.core(p.id), {
			command: "create-session",
			sessionId: s.id,
			name: s.name,
			operationId: randomUUID(),
		});
		const named = await this.names.call(this.core(p.id), {
			command: "rename-session",
			sessionId: s.id,
			name: s.name,
			expectedRevision: 0,
			operationId: randomUUID(),
		});
		s.name = named.name;
		s.nameRevision = named.revision;
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
		if (name !== project.name) await this.renameProject({ ...p, name });
		Object.assign(project, { directory, instructions });
		await this.save();
		return project;
	}
	async renameProject(p: any) {
		const project = this.project(p.projectId);
		if (this.state.active?.projectId === project.id)
			throw new Error("Running project cannot be renamed");
		const named = await this.names.call(this.core(project.id), {
			command: "rename-project",
			projectId: project.id,
			name: text(p.name, 80),
			expectedRevision: p.expectedRevision ?? project.nameRevision,
			operationId: p.operationId ?? randomUUID(),
		});
		project.name = named.name;
		project.nameRevision = named.revision;
		await this.save();
		return project;
	}
	async renameSession(p: any) {
		const session = this.assertMovable(p.projectId, p.sessionId);
		const named = await this.names.call(
			this.location(p.projectId, p.sessionId).core,
			{
				command: "rename-session",
				sessionId: session.id,
				name: text(p.name, 80),
				expectedRevision: p.expectedRevision ?? session.nameRevision,
				operationId: p.operationId ?? randomUUID(),
			},
		);
		session.name = named.name;
		session.nameRevision = named.revision;
		await this.save();
		return session;
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

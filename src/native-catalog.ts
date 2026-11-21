import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
	ProjectMutation,
	ProjectQuery,
	ProjectStore,
} from "@cybergarage/orbit";
import type { CoreNames } from "./core-names";
import { assertNativeHostAgentProfile } from "./host-profile";
import { assertMetadataHelperAbsent } from "./metadata-helper";

async function optionalStat(file: string) {
	try {
		return await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function owned(stat: { uid: number; mode: number }) {
	const uid = process.getuid?.();
	return (uid === undefined || uid === stat.uid) && (stat.mode & 0o077) === 0;
}

function checkAddon() {
	try {
		const localRequire = createRequire(
			typeof __filename === "string"
				? __filename
				: path.join(process.cwd(), "package.json"),
		);
		const Database = localRequire("better-sqlite3");
		const check = new Database(":memory:");
		try {
			if (check.prepare("SELECT 1 AS ok").get().ok !== 1)
				throw new Error("SQLite preflight failed");
		} finally {
			check.close();
		}
	} catch (cause) {
		throw new Error(
			"Native SQLite is unavailable for this runtime; rebuild the Host Agent package. Docker fallback is disabled.",
			{ cause },
		);
	}
}

const str = (value: unknown) => {
	if (typeof value !== "string")
		throw new Error("Invalid Project catalog field");
	return value;
};

/** One SQLite worker owned by Electron's profile lock. No container backend. */
export class NativeProjectCatalog implements CoreNames {
	private opened?: Promise<ProjectStore>;
	private closing?: Promise<void>;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly root: string,
		private readonly preflight: () => void = checkAddon,
	) {}

	async prepare() {
		if (this.closing) throw new Error("Native Project catalog is closed");
		this.opened ??= this.open();
		await this.opened;
	}

	private async open() {
		assertNativeHostAgentProfile(this.root);
		await assertMetadataHelperAbsent(this.root);
		// Core can create the on-disk database before binding its native addon.
		// Probe the real ABI in memory first; an invalid addon must not write a file.
		this.preflight();
		const dir = path.join(this.root, "catalog");
		const stat = await optionalStat(dir);
		if (
			stat &&
			(!stat.isDirectory() || !owned(stat) || (await fs.realpath(dir)) !== dir)
		)
			throw new Error("Unsafe native Project catalog directory");
		const file = path.join(dir, "projects.sqlite");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			const entry = await optionalStat(file + suffix);
			if (entry && (!entry.isFile() || entry.nlink !== 1 || !owned(entry)))
				throw new Error("Unsafe native Project catalog file");
		}
		const { SqliteProjectStore } = await import("@cybergarage/orbit");
		return SqliteProjectStore.open({ file });
	}

	call(dir: string, request: Record<string, unknown>) {
		if (this.closing || !this.opened || dir !== path.join(this.root, "catalog"))
			return Promise.reject(
				new Error("Native Project catalog is not admitted"),
			);
		const opening = this.opened;
		const call = this.tail.then(async () => {
			const catalog = await opening;
			switch (request.command) {
				case "catalog-query":
					return catalog.query(request.query as ProjectQuery);
				case "catalog-mutate":
					return catalog.mutate(
						str(request.operationId),
						request.mutation as ProjectMutation,
					);
				case "create-project": {
					const id = str(request.projectId);
					return catalog.mutate(id, {
						kind: "create",
						id,
						name: str(request.name),
						expectedRevision: 0,
						directory: null,
					});
				}
				case "read-project": {
					const project = await catalog.query({
						kind: "project",
						id: str(request.projectId),
					});
					if (!project)
						throw new Error("Core project not found; refresh before editing");
					return project;
				}
				case "rename-project": {
					if (!Number.isSafeInteger(request.expectedRevision))
						throw new Error("Invalid Project revision");
					return catalog.mutate(str(request.operationId), {
						kind: "rename",
						id: str(request.projectId),
						name: str(request.name),
						expectedRevision: Number(request.expectedRevision),
					});
				}
				case "archive-project": {
					if (typeof request.archived !== "boolean")
						throw new Error("Invalid archive flag");
					const project = await catalog.query({
						kind: "project",
						id: str(request.projectId),
					});
					if (!project) throw new Error("Project missing");
					return catalog.mutate(str(request.operationId), {
						kind: "update",
						id: project.id,
						expectedRevision: project.revision,
						archived: request.archived,
					});
				}
				default:
					throw new Error("Unsupported native Project catalog operation");
			}
		});
		this.tail = call.catch(() => {});
		return call;
	}

	close() {
		this.closing ??= this.tail.then(async () => {
			// A failed preflight never opened SQLite.
			const catalog = await this.opened?.catch(() => undefined);
			await catalog?.close();
		});
		return this.closing;
	}
}

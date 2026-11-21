import fs from "node:fs/promises";
import path from "node:path";
import type { CoreNames } from "./core-names";
import type { AcquireSources } from "./source-leases";

const hosts = new Set([
	"create-session",
	"read-sessions",
	"rename-session",
	"archive-session",
]);
const metadata = new Set([
	"create-project",
	"read-project",
	"rename-project",
	"archive-project",
	"catalog-query",
	"catalog-mutate",
]);
export const hostOriginator = "orbit-app-host-v1";
export async function hostRepository(core: string) {
	if (!path.isAbsolute(core) || (await fs.realpath(core)) !== core)
		throw new Error(
			"Host SessionRepository requires canonical App-owned Core storage",
		);
	const { SessionRepository } = await import("@cybergarage/orbit");
	return new SessionRepository({
		rootDir: path.join(core, "sessions"),
		journalRoot: path.join(core, "runs"),
	});
}

/** The admitted host catalog and session repository share App ownership. */
export class HostCoreNames implements CoreNames {
	private readonly catalog: CoreNames;
	private tail: Promise<unknown> = Promise.resolve();
	private closing?: Promise<void>;

	constructor(
		private root: string,
		catalog: CoreNames,
	) {
		this.catalog = catalog;
	}

	call(core: string, request: Record<string, unknown>) {
		if (this.closing)
			return Promise.reject(new Error("Host Core storage is closed"));
		const call = this.tail.then(() => this.dispatch(core, request));
		this.tail = call.catch(() => {});
		return call;
	}

	close() {
		this.closing ??= this.tail.then(() => this.catalog.close?.());
		return this.closing;
	}

	private async dispatch(core: string, request: Record<string, unknown>) {
		const name = String(request.command);
		const relative = path.relative(this.root, core).split(path.sep);
		const validProject =
			relative.length === 3 &&
			relative[0] === "projects" &&
			/^[a-f0-9-]{36}$/.test(relative[1]) &&
			relative[2] === "core" &&
			path.isAbsolute(core) &&
			path.resolve(core) === core;
		const catalog = path.join(this.root, "catalog");
		if (!validProject && !(core === catalog && name.startsWith("catalog-")))
			throw new Error("Host Core path is outside the selected App profile");
		if (metadata.has(name)) {
			if (name === "create-project") {
				await fs.mkdir(core, { recursive: true, mode: 0o700 });
			}
			return this.catalog.call(catalog, request);
		}
		if (!hosts.has(name))
			throw new Error("Unsupported host Core metadata operation");
		const repo = await hostRepository(core);
		const { sessionDisplayName } = await import("@cybergarage/orbit");
		const read = async (id: unknown) => {
			if (typeof id !== "string") throw new Error("Invalid host session ID");
			const found = await repo.findById(id);
			if (!found || found.originator !== hostOriginator)
				throw new Error(
					"Host session is missing or belongs to another backend",
				);
			return found;
		};
		if (name === "create-session") {
			const cwd = request.hostWorkspace;
			if (
				typeof cwd !== "string" ||
				!path.isAbsolute(cwd) ||
				(await fs.realpath(cwd)) !== cwd
			)
				throw new Error(
					"Host session requires the canonical selected workspace",
				);
			const inspection = repo.inspectStorage();
			if (inspection.state === "unregistered") {
				repo.initializeStorage({
					allWritersStopped: true,
					automaticRestartersDisabled: true,
					exclusiveStorageControl: true,
				});
			}
			if (
				typeof request.sessionId !== "string" ||
				(await repo.findById(request.sessionId))
			)
				throw new Error("Invalid or duplicate host session");
			const session = repo.create({
				id: request.sessionId,
				cwd,
				provider: "ollama",
				formatVersion: 3,
				originator: hostOriginator,
			});
			try {
				await session.synchronize("file-and-directory-sync");
			} finally {
				await session.close();
			}
			return { revision: 0 };
		}
		if (name === "read-sessions") {
			if (!Array.isArray(request.sessionIds))
				throw new Error("Invalid host session group");
			const rows = [];
			for (const id of request.sessionIds) {
				const found = await read(id);
				rows.push({
					id,
					name: sessionDisplayName(found),
					revision: found.titleRevision,
				});
			}
			return rows;
		}
		const found = await read(request.sessionId);
		if (name === "archive-session") {
			if (typeof request.archived !== "boolean")
				throw new Error("Invalid archive flag");
			return repo.setArchived(found.id, request.archived);
		}
		if (
			typeof request.name !== "string" ||
			typeof request.operationId !== "string" ||
			typeof request.expectedRevision !== "number"
		)
			throw new Error("Invalid host rename request");
		const renamed = await repo.rename(found.id, {
			title: request.name,
			expectedRevision: request.expectedRevision,
			operationId: request.operationId,
		});
		return {
			name: sessionDisplayName(renamed),
			revision: renamed.titleRevision,
		};
	}
}

export const acquireHostSources: AcquireSources = async (core, sessionIds) => {
	const { ProjectSourceLease } = await import("@cybergarage/orbit");
	const repository = await hostRepository(core);
	const lease = ProjectSourceLease.acquire(repository, sessionIds);
	let open = true;
	try {
		const captures = [];
		for (const id of sessionIds) {
			const found = await repository.findById(id);
			if (found?.originator !== hostOriginator)
				throw new Error("Not a host source session");
			captures.push(await lease.capture(id));
		}
		if (Buffer.byteLength(JSON.stringify(captures)) > 4 * 1024 * 1024)
			throw new Error("Host Project source capture exceeds limit");
		return {
			captures,
			assertHeld: () => {
				if (!open) throw new Error("Host Project source lease closed");
			},
			release: async () => {
				if (open) {
					open = false;
					lease.close();
				}
			},
		};
	} catch (error) {
		lease.close();
		throw error;
	}
};

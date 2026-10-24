import fs from "node:fs/promises";
import path from "node:path";
import {
	MetadataRecoveryRequired,
	assertMetadataHelperAbsent,
	recoverMetadataHelper,
	runMetadataHelper,
	type MetadataHelperOptions,
} from "./metadata-helper";
export interface CoreNames {
	call(core: string, request: Record<string, unknown>): Promise<any>;
	close?(): Promise<void>;
}
// All ephemeral metadata helpers for one canonical App profile share one lane.
// Per-instance queues let Store and background knowledge open the same bind-mounted
// SQLite catalog concurrently. This is coordination, never a second storage DB.
const profileOperations = new Map<string, Promise<unknown>>();
const blockedProfiles = new Map<string, Error>();
export class ContainerCoreNames implements CoreNames {
	private operations: Promise<unknown> = Promise.resolve();
	private closed = false;
	async close() {
		this.closed = true;
		await this.operations;
		const key = path.resolve(this.root);
		// Drain and inspect through the same lane, including fresh clients after a
		// restart. A durable orphan must not turn into a successful empty close.
		const operation = (profileOperations.get(key) ?? Promise.resolve()).then(
			async () => {
				const blocked = blockedProfiles.get(key);
				if (blocked) throw blocked;
				await assertMetadataHelperAbsent(this.root);
			},
		);
		const settled = operation.catch((error) => {
			if (error instanceof MetadataRecoveryRequired)
				blockedProfiles.set(key, error);
		});
		profileOperations.set(key, settled);
		try {
			await operation;
		} finally {
			if (profileOperations.get(key) === settled) profileOperations.delete(key);
		}
	}
	constructor(
		private readonly root: string,
		private readonly helperOptions: MetadataHelperOptions = {},
	) {}
	static async recover(root: string, options: MetadataHelperOptions = {}) {
		const key = path.resolve(root);
		const operation = (profileOperations.get(key) ?? Promise.resolve()).then(
			async () => {
				await recoverMetadataHelper(root, options.transport);
				blockedProfiles.delete(key);
			},
		);
		const settled = operation.catch(() => {});
		profileOperations.set(key, settled);
		try {
			await operation;
		} finally {
			if (profileOperations.get(key) === settled) profileOperations.delete(key);
		}
	}
	call(core: string, request: Record<string, unknown>) {
		if (this.closed)
			return Promise.reject(new Error("Core metadata storage is closed"));
		const key = path.resolve(this.root);
		const operation = (profileOperations.get(key) ?? Promise.resolve()).then(
			() => {
				const blocked = blockedProfiles.get(key);
				if (blocked) throw blocked;
				return this.performCall(core, request);
			},
		);
		const settled = operation.catch((error) => {
			if (error instanceof MetadataRecoveryRequired)
				blockedProfiles.set(key, error);
		});
		profileOperations.set(key, settled);
		this.operations = settled;
		void settled.then(() => {
			if (profileOperations.get(key) === settled) profileOperations.delete(key);
		});
		return operation;
	}
	protected async performCall(core: string, request: Record<string, unknown>) {
		const catalog = path.join(this.root, "catalog");
		if (request.command !== "create-project") {
			await fs.access(path.join(catalog, "projects.sqlite"));
			if (!(await fs.stat(core)).isDirectory())
				throw new Error("Core storage directory is missing");
		} else {
			await fs.mkdir(catalog, { recursive: true, mode: 0o700 });
			await fs.mkdir(core, { recursive: true, mode: 0o700 });
		}
		return runMetadataHelper(this.root, core, request, this.helperOptions);
	}
}

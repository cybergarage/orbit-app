import { closeSourceNamespace } from "./source-namespace";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
	ProjectSourceCapture,
	ProjectExtractionJob,
	KnowledgeExtractor,
	ProjectContextSnapshot,
	ProjectAutomation,
	ProjectStore,
	ProjectQuery,
	ProjectQueryResults,
	ProjectMutation,
} from "@cybergarage/orbit";
type CoreKnowledge = typeof import("@cybergarage/orbit");

import { ContainerCoreNames } from "./core-names";
import type { Store } from "./store";
import {
	acquireContainerSources,
	type AcquireSources,
	type SourceLease,
} from "./source-leases";

export const extractLocalKnowledge: KnowledgeExtractor = async (
	input,
	signal,
) => {
	const core = await import("@cybergarage/orbit");
	return core.createOllamaKnowledgeExtractor()(input, signal);
};

class RemoteProjectCatalog implements ProjectStore {
	private metadata: ContainerCoreNames;
	constructor(private root: string) {
		this.metadata = new ContainerCoreNames(root);
	}
	async query<Q extends ProjectQuery>(
		query: Q,
	): Promise<ProjectQueryResults[Q["kind"]]> {
		return this.metadata.call(path.join(this.root, "catalog"), {
			command: "catalog-query",
			query,
		});
	}
	async mutate(operationId: string, mutation: ProjectMutation) {
		return this.metadata.call(path.join(this.root, "catalog"), {
			command: "catalog-mutate",
			operationId,
			mutation,
		});
	}
	async close() {
		await this.metadata.close();
	}
}

/** Catalog is shared with metadata workers; source roots remain inside original worker mounts. */
export class ProjectKnowledge {
	private catalog?: ProjectStore;
	private core?: CoreKnowledge;
	private queue: Promise<unknown> = Promise.resolve();
	private background?: Promise<void>;
	private controller?: AbortController;
	private stopped = false;
	private wakeup?: ReturnType<typeof setTimeout>;
	private nextDelay = 5000;
	private suspended = false;
	private needsWakeup = false;
	private nextPollAt = 0;
	private blocked?: string;
	constructor(
		private store: Store,
		private idle: () => boolean,
		private acquire: AcquireSources = acquireContainerSources,
		private extract: KnowledgeExtractor = extractLocalKnowledge,
	) {}

	private get kit(): CoreKnowledge {
		if (!this.core) throw new Error("Core knowledge is not initialized");
		return this.core;
	}

	private get db(): ProjectStore {
		if (!this.catalog) throw new Error("Project knowledge is not initialized");
		return this.catalog;
	}
	async init(catalog?: ProjectStore) {
		this.core = await import("@cybergarage/orbit");
		this.catalog = catalog ?? new RemoteProjectCatalog(this.store.root);
		this.scheduleWakeup();
	}
	gate<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			if (this.blocked) throw new Error(this.blocked);
			return work();
		});
		this.queue = next.catch(() => {});
		return next;
	}
	private locate(id: string) {
		for (const project of this.store.state.projects) {
			const session = project.sessions.find((item) => item.id === id);
			if (session)
				return {
					project,
					session,
					core: this.store.location(project.id, id).core,
				};
		}
		throw new Error("Knowledge source no longer exists");
	}
	private async sources<T>(
		ids: string[],
		work: (
			captures: Map<string, ProjectSourceCapture>,
			held: () => void,
		) => Promise<T>,
	): Promise<T> {
		const groups = new Map<string, string[]>();
		for (const id of new Set(ids)) {
			const core = this.locate(id).core;
			groups.set(core, [...(groups.get(core) ?? []), id]);
		}
		const leases: SourceLease[] = [];
		const outcome = await (async () => {
			try {
				for (const [core, sessions] of [...groups].sort(([a], [b]) =>
					a.localeCompare(b),
				))
					leases.push(await this.acquire(core, sessions.sort()));
				const captures = new Map(
					leases.flatMap((lease) =>
						lease.captures.map(
							(capture) => [capture.sessionId, capture] as const,
						),
					),
				);
				if (captures.size !== new Set(ids).size)
					throw new Error("Incomplete Project source capture");
				const held = () => {
					for (const lease of leases) lease.assertHeld();
				};
				held();
				const value = await work(captures, held);
				held();
				return { ok: true as const, value };
			} catch (error) {
				return { ok: false as const, error };
			}
		})();
		const releases = await Promise.allSettled(
			leases.reverse().map((lease) => lease.release()),
		);
		const failures = releases.filter((result) => result.status === "rejected");
		if (failures.length) {
			this.blocked =
				"Source ownership cleanup failed; restart and reconcile helpers before admitting work";
			throw new AggregateError(
				failures.map((result) => result.reason),
				this.blocked,
			);
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}
	private async sync(capture: ProjectSourceCapture) {
		const { project } = this.locate(capture.sessionId);
		const projectId = project.unassigned ? null : project.id;
		const member = await this.db.query({
			kind: "membership",
			pairId: capture.pairId,
			sessionId: capture.sessionId,
		});
		if (member?.projectId !== projectId || member.unavailable !== false) {
			return (await this.db.mutate(randomUUID(), {
				kind: "membership",
				expectedRevision: member?.revision ?? 0,
				pairId: capture.pairId,
				sessionId: capture.sessionId,
				projectId,
				sourceProjectId: member?.projectId ?? null,
				unavailable: false,
			})) as any;
		}
		return member;
	}
	private async validate(
		job: ProjectExtractionJob,
		apply?: () => Promise<void>,
	) {
		try {
			this.locate(job.sessionId);
		} catch {
			return false;
		}
		return this.gate(() =>
			this.sources([job.sessionId], async (captures, held) => {
				const capture = captures.get(job.sessionId);
				if (!capture) return false;
				const member = await this.sync(capture);
				const admitted = capture.runs.find((run) => run.runId === job.runId);
				if (
					!admitted ||
					!job.admissionDigest ||
					admitted.snapshot.digest !== job.admissionDigest ||
					admitted.snapshot.membershipRevision !== job.membershipRevision
				)
					return false;
				if (
					capture.archived ||
					capture.pairId !== job.pairId ||
					member.projectId !== job.projectId ||
					member.revision !== job.membershipRevision ||
					this.kit.projectSourceDigest(job.messages) !== job.sourceDigest ||
					job.messages.some(
						(message) =>
							!capture.messages.some(
								(source) =>
									source.id === message.id && source.digest === message.digest,
							),
					)
				)
					return false;
				held();
				await apply?.();
				held();
				return true;
			}),
		);
	}
	async prepare(
		projectId: string,
		sessionId: string,
		requestId: string,
		request: string,
	): Promise<ProjectContextSnapshot | undefined> {
		if (this.locate(sessionId).project.unassigned) return;
		return this.gate(async () => {
			const entries = await this.db.query({
				kind: "memories",
				projectId,
				retired: false,
			});
			const knownIds = entries.flatMap((entry) =>
				entry.sources.flatMap((source) => {
					try {
						this.locate(source.sessionId);
						return [source.sessionId];
					} catch {
						return [];
					}
				}),
			);
			return this.sources([sessionId, ...knownIds], async (captures, held) => {
				const current = captures.get(sessionId);
				if (!current) throw new Error("Current source missing");
				const membership = await this.sync(current);
				const ineligible = new Map<string, string>();
				for (const capture of captures.values()) await this.sync(capture);
				const catalog = await this.db.query({
					kind: "snapshot",
					projectId,
					pairId: current.pairId,
					sessionId,
				});
				for (const entry of catalog.entries)
					for (const source of entry.sources) {
						const capture = captures.get(source.sessionId);
						if (
							!capture ||
							capture.archived ||
							capture.pairId !== source.pairId ||
							this.locate(source.sessionId).project.id !== projectId ||
							!capture.messages.some(
								(message) =>
									message.id === source.messageId &&
									message.digest === source.digest,
							)
						)
							ineligible.set(entry.id, "source-unavailable");
					}
				const snapshot = this.kit.selectProjectMemory(catalog, {
					captureId: this.kit.stableMemoryId([
						membership.pairId,
						sessionId,
						requestId,
					]),
					execution: "agent",
					request,
					ineligible,
					crossPair: true,
				});
				held();
				await this.db.mutate(snapshot.captureId, {
					kind: "capture",
					generation: snapshot.generation,
					membershipRevision: snapshot.membershipRevision,
					pairId: snapshot.pairId,
					projectId,
					sessionId,
					snapshotDigest: snapshot.digest,
				});
				return snapshot;
			});
		});
	}
	async synchronize(sessionId?: string) {
		return this.gate(() =>
			this.sources(
				sessionId
					? [sessionId]
					: this.store.state.projects.flatMap((project) =>
							project.sessions.map((session) => session.id),
						),
				async (captures) => {
					for (const capture of captures.values()) await this.sync(capture);
				},
			),
		);
	}
	poll() {
		if (!this.wakeup && !this.background && Date.now() >= this.nextPollAt)
			this.kick();
	}
	private scheduleWakeup() {
		if (this.stopped || this.suspended || this.blocked || this.wakeup) return;
		this.wakeup = setTimeout(() => {
			this.wakeup = undefined;
			this.kick();
			if (!this.background) this.scheduleWakeup();
		}, this.nextDelay);
		this.wakeup.unref();
	}
	kick() {
		this.suspended = false;
		if (this.stopped || this.background || !this.idle() || !this.catalog) {
			this.scheduleWakeup();
			return;
		}
		if (this.wakeup) clearTimeout(this.wakeup);
		this.wakeup = undefined;
		this.nextDelay = 5000;
		this.needsWakeup = false;
		this.controller = new AbortController();
		this.background = this.work()
			.catch(() => {
				this.needsWakeup = true;
			})
			.finally(() => {
				this.background = undefined;
				this.nextPollAt = Date.now() + 5000;
				if (this.needsWakeup) this.scheduleWakeup();
			});
	}
	private async work() {
		const projects = this.store.state.projects.filter(
			(project) => !project.unassigned && !project.archived,
		);
		for (const project of projects) {
			if (this.stopped || !this.idle() || this.controller?.signal.aborted)
				return;
			const config = await this.db.query({
				kind: "automation",
				id: project.id,
			});
			if (config?.enabled === false) continue;
			if (
				config &&
				((config.calls ?? 0) >= (config.maxCalls ?? 16) ||
					config.inputTokens + 4096 > config.maxInputTokens ||
					config.outputTokens + 1024 > config.maxOutputTokens)
			)
				continue;
			const status = await this.db.query({
				kind: "automation-status",
				projectId: project.id,
			});
			let available = status.queue.limit - status.queue.pending;
			for (const session of project.sessions) {
				if (available <= 0) break;
				if (this.stopped || !this.idle() || this.controller?.signal.aborted)
					return;
				await this.gate(() =>
					this.sources([session.id], async (captures, held) => {
						const capture = captures.get(session.id);
						if (!capture) throw new Error("Source missing");
						const member = await this.sync(capture);
						if (capture.archived) return;
						for (const run of capture.runs) {
							if (available <= 0) break;
							if (
								run.snapshot.projectId !== project.id ||
								run.snapshot.membershipRevision !== member.revision
							)
								continue;
							const id = this.kit.stableMemoryId([
								capture.pairId,
								session.id,
								run.runId,
								"extract-v1",
							]);
							if (await this.db.query({ kind: "extraction", id })) continue;
							const messages = capture.messages.flatMap((message) =>
								message.turnId === run.runId && message.text
									? [
											{
												id: message.id,
												digest: message.digest,
												role: message.role,
												text: message.text,
											},
										]
									: [],
							);
							if (
								!messages.length ||
								messages.length > 32 ||
								Buffer.byteLength(JSON.stringify(messages)) > 12000
							)
								continue;
							const job: ProjectExtractionJob = {
								admissionDigest: run.snapshot.digest,
								id,
								projectId: project.id,
								pairId: capture.pairId,
								sessionId: session.id,
								runId: run.runId,
								membershipRevision: member.revision,
								sourceDigest: this.kit.projectSourceDigest(messages),
								messages,
								state: "pending",
								revision: 0,
								attempt: 0,
								inputTokens: 0,
								outputTokens: 0,
							};
							held();
							await this.db.mutate(this.kit.stableMemoryId([id, "enqueue"]), {
								kind: "extraction",
								expectedRevision: 0,
								job,
								entries: [],
								generation: 0,
							});
							available--;
						}
					}),
				);
			}
			const runner = new this.kit.AutomaticProjectMemory(
				this.db,
				(input, signal) => {
					const controller = this.controller;
					if (!controller) throw new Error("Extractor not owned");
					const combined = AbortSignal.any([signal, controller.signal]);
					return Promise.race([
						this.extract(input, combined),
						new Promise<never>((_, reject) => {
							if (combined.aborted)
								reject(new Error("Knowledge extraction interrupted"));
							else
								combined.addEventListener(
									"abort",
									() => reject(new Error("Knowledge extraction interrupted")),
									{ once: true },
								);
						}),
					]);
				},
				(job, apply) => this.validate(job, apply),
			);
			const jobs = await this.db.query({
				kind: "extractions",
				projectId: project.id,
			});
			for (const job of jobs
				.filter(
					(job) =>
						job.attempt < 3 && !["completed", "discarded"].includes(job.state),
				)
				.slice(0, 4)) {
				if (this.stopped || !this.idle() || this.controller?.signal.aborted)
					return;
				this.needsWakeup = true;
				this.nextDelay = Math.max(
					this.nextDelay === 5000 ? 1000 : this.nextDelay,
					Math.min(60000, 1000 * 2 ** job.attempt),
				);
				await runner.process(job).catch(() => {});
			}
		}
	}
	async status(projectId: string) {
		return {
			...(await this.db.query({ kind: "automation-status", projectId })),
			blocked: this.blocked,
		};
	}
	async configure(
		projectId: string,
		enabled: boolean,
		limits?: Pick<
			ProjectAutomation,
			"maxInputTokens" | "maxOutputTokens" | "maxCalls"
		>,
	) {
		await this.interrupt();
		await this.gate(async () => {
			const config = (await this.db.query({
				kind: "automation",
				id: projectId,
			})) ?? {
				id: projectId,
				enabled: true,
				revision: 0,
				inputTokens: 0,
				outputTokens: 0,
				maxInputTokens: 100000,
				maxOutputTokens: 16384,
			};
			await this.db.mutate(randomUUID(), {
				kind: "automation",
				expectedRevision: config.revision,
				config: { ...config, ...limits, enabled },
			});
		});
		this.kick();
	}
	async edit(
		projectId: string,
		id: string,
		body: string,
		retired: boolean,
		expectedRevision: number,
	) {
		return this.gate(async () => {
			const old = await this.db.query({ kind: "memory", id });
			if (!old || old.projectId !== projectId)
				throw new Error("Knowledge entry missing");
			const { createdAt, updatedAt, revision, ...entry } = old;
			void createdAt;
			void updatedAt;
			void revision;
			return this.db.mutate(randomUUID(), {
				kind: "memory",
				expectedRevision,
				entry: {
					...entry,
					body,
					retired,
					edited: true,
					...(entry.automatic
						? { automatic: { ...entry.automatic, pending: false } }
						: {}),
				},
			});
		});
	}
	async settle() {
		await this.background;
		await this.queue;
	}

	async interrupt() {
		this.suspended = true;
		if (this.wakeup) clearTimeout(this.wakeup);
		this.wakeup = undefined;
		this.controller?.abort();
		await this.background;
		await this.queue;
		if (this.blocked) throw new Error(this.blocked);
	}
	async close() {
		this.stopped = true;
		await this.interrupt();
		await this.catalog?.close();
		await closeSourceNamespace(this.store.root);
	}
}

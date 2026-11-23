import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
	Agent,
	AgentOptions,
	PreparedWorkspaceOperation,
	ProjectContextSnapshot,
	ProviderName,
	Session,
	ToolResult,
	WorkspaceExecutor,
	WorkspaceCommandAdapter,
	WorkspaceCommandOutcome,
} from "@cybergarage/orbit";
import { hostOriginator, hostRepository } from "./host-core";
import {
	admitWorkspaceReaderImage,
	admitWorkspaceWriterImage,
	command,
	dockerPath,
	dockerWorkspaceArgs,
	stopWorkerWorkspaceMutation,
	verifySessionWriterReleased,
} from "./worker";
import {
	executeWorkspaceMutation,
	executeWorkspaceObservation,
} from "./workspace-mutation-client";

import {
	approvedReadiness,
	readinessInput,
	readinessProfile,
	type HostCommandProbe,
} from "./workspace-readiness";

const readers = ["read", "list", "glob", "grep"] as const;
type Reader = (typeof readers)[number];
const canRead = (name: string): name is Reader =>
	readers.some((reader) => reader === name);
const noRead = (): ToolResult => ({
	content: [
		{
			type: "text",
			text: "The isolated workspace reader is unavailable; no host fallback.",
		},
	],
	isError: true,
});

export interface HostReader {
	admit(): Promise<string>;
	read(
		parent: string,
		workspace: string,
		artifact: string,
		operation: PreparedWorkspaceOperation,
		signal: AbortSignal,
	): Promise<ToolResult>;
	stop(parent: string): Promise<unknown>;
}
export function createDockerHostReader(
	imageRef?: string,
	run: typeof command = command,
): HostReader {
	return {
		admit: () => admitWorkspaceReaderImage(run, imageRef),
		read: (parent, workspace, artifact, operation, signal) =>
			executeWorkspaceObservation(
				parent,
				workspace,
				operation,
				signal,
				{
					docker: dockerPath,
					command: run,
					args: (name, root) => dockerWorkspaceArgs(name, root, artifact, true),
				},
				workspace,
			),
		stop: (parent) => stopWorkerWorkspaceMutation(parent, true),
	};
}
const dockerReader = createDockerHostReader();

const mutations = ["write", "edit"] as const;
const canMutate = (name: string) => mutations.some((tool) => tool === name);

export interface HostWriter {
	admit(): Promise<string>;
	mutate(
		parent: string,
		workspace: string,
		artifact: string,
		operation: PreparedWorkspaceOperation,
		signal: AbortSignal,
	): Promise<ToolResult>;
	stop(parent: string): Promise<unknown>;
}

export function createDockerHostWriter(
	imageRef?: string,
	run: typeof command = command,
): HostWriter {
	return {
		admit: () => admitWorkspaceWriterImage(run, imageRef),
		mutate: (parent, workspace, artifact, operation, signal) =>
			executeWorkspaceMutation(
				parent,
				workspace,
				operation,
				signal,
				{
					docker: dockerPath,
					command: run,
					args: (name, root) =>
						dockerWorkspaceArgs(name, root, artifact, false, true),
				},
				workspace,
			),
		stop: (parent) => stopWorkerWorkspaceMutation(parent),
	};
}

type HostApproval = Parameters<
	NonNullable<NonNullable<AgentOptions["execution"]>["onApproval"]>
>[0];

interface HostRunConfig {
	sessionId: string;
	requestId: string;
	prompt: string;
	model: string;
	provider: ProviderName;
	projectContext?: ProjectContextSnapshot;
}
type ProviderRequest = (
	route: string,
	body: unknown,
	signal: AbortSignal,
) => Promise<unknown>;
const maxFiles = 24;

function withinRoot(workspace: string, target: string) {
	const rel = path.relative(workspace, target);
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	);
}

function selectedPattern(value: unknown) {
	const patterns =
		value === undefined ? ["**/*"] : Array.isArray(value) ? value : [value];
	return (
		patterns.length > 0 &&
		patterns.length <= 16 &&
		patterns.every(
			(entry) =>
				typeof entry === "string" &&
				entry.length <= 2048 &&
				!/[{}()[\]\\]/.test(entry),
		)
	);
}

async function identity(workspace: string) {
	const info = await fs.lstat(workspace, { bigint: true });
	if (!info.isDirectory() || (await fs.realpath(workspace)) !== workspace)
		throw new Error("Host run workspace no longer matches its original mount");
	return `${info.dev}:${info.ino}`;
}

function projectMemory(
	api: typeof import("@cybergarage/orbit"),
	snapshot: ProjectContextSnapshot,
): AgentOptions["projectMemory"] {
	type Service = NonNullable<AgentOptions["projectMemory"]>;
	// This matches the existing App adapter: Core Agent only calls prepare;
	// the already-admitted snapshot does not add model-controlled memory tools.
	const adapter: Pick<Service, "prepare"> = {
		prepare: async () => api.parseProjectContext(snapshot),
	};
	return adapter as Service;
}

/** Runs Core in the host with only explicitly routed workspace operations. */
export class HostAgentRun {
	readonly name = `orbit-app-${randomUUID()}`; // durable executor child ownership
	readonly workspaceReadsEnabled = true;
	private readonly controller = new AbortController();
	private agent?: Agent;
	private session?: Session;
	private handle?: Awaited<ReturnType<Agent["startRun"]>>;
	private running?: Promise<void>;
	private readerAdmitted = false;
	private writerAdmitted = false;
	private readinessAdmitted = false;
	private readinessUsed = false;
	private approval?: HostApproval;
	private readerBlocked = false;
	private readerTail = Promise.resolve();
	private toolCalls = 0;
	private providerCalls = 0;

	constructor(
		private workspace: string,
		private core: string,
		private config: HostRunConfig,
		private event: (event: { type: string; data: unknown }) => void,
		private request: ProviderRequest,
		private reader: HostReader = dockerReader,
		private writer?: HostWriter,
		private commandProbe?: HostCommandProbe,
	) {}

	get workspaceMutationsEnabled() {
		return this.writer !== undefined;
	}

	async approve(id: unknown, approve: unknown) {
		const request = this.approval;
		if (
			(!this.writer && !this.commandProbe) ||
			!request ||
			!this.agent ||
			this.controller.signal.aborted ||
			request.expiresAt <= Date.now() ||
			request.sessionId !== this.config.sessionId ||
			request.responderScope !== "desktop-owner" ||
			(this.handle !== undefined && this.handle.id !== request.runId) ||
			id !== request.id ||
			typeof approve !== "boolean"
		)
			throw new Error("Approval is no longer pending");
		this.approval = undefined;
		await this.agent.replyApproval(request.runId, {
			requestId: request.id,
			digest: request.digest,
			responderScope: request.responderScope,
			approve,
		});
	}

	start() {
		this.running ??= this.run();
		return this.running;
	}

	async stop() {
		this.controller.abort();
		this.approval = undefined;
		this.handle?.requestStop("User cancelled");
		await this.running?.catch(() => {});
	}

	async confirmGone() {
		await this.readerTail;
		if (this.readinessAdmitted) await this.commandProbe?.stop(this.name);
		if (this.writerAdmitted) await this.writer?.stop(this.name);
		if (this.readerAdmitted) await this.reader.stop(this.name);
		await verifySessionWriterReleased(this.core, this.config.sessionId);
	}

	private readinessAdapter(
		artifact: string,
		before: string,
	): WorkspaceCommandAdapter {
		const probe = this.commandProbe;
		if (!probe) throw new Error("Readiness probe is not configured");
		const profile = readinessProfile(artifact);
		return {
			profile,
			revalidate: async (op, signal) =>
				!signal.aborted &&
				!this.controller.signal.aborted &&
				!this.readinessUsed &&
				approvedReadiness(op, this.workspace, artifact) &&
				(await identity(this.workspace)) === before &&
				(await probe.revalidate(artifact, signal)),
			execute: async (op, runSignal) => {
				const signal = AbortSignal.any([runSignal, this.controller.signal]);
				if (
					signal.aborted ||
					this.readinessUsed ||
					this.readerBlocked ||
					!approvedReadiness(op, this.workspace, artifact)
				)
					return { status: "unknown" };
				this.readinessUsed = true;
				const task = this.readerTail.then(
					async (): Promise<WorkspaceCommandOutcome> => {
						if (
							signal.aborted ||
							this.readerBlocked ||
							(await identity(this.workspace)) !== before
						)
							return { status: "unknown" };
						return probe.execute(
							this.name,
							this.workspace,
							artifact,
							op,
							signal,
						);
					},
				);
				this.readerTail = task.then(
					() => {},
					() => {
						this.readerBlocked = true;
					},
				);
				return task;
			},
		};
	}

	private fileRunner(
		image: string,
		before: string,
		writerImage?: string,
		readiness?: WorkspaceCommandAdapter,
	): WorkspaceExecutor {
		return {
			toolNames: [
				...readers,
				...(writerImage ? mutations : []),
				...(readiness ? (["bash"] as const) : []),
			],
			...(readiness ? { command: readiness } : {}),
			execute: (op, runSignal) => {
				if (op.effect === "write")
					return this.mutate(op, runSignal, before, writerImage);
				if (
					++this.toolCalls > maxFiles ||
					op.effect !== "read" ||
					!canRead(op.name) ||
					op.cwd !== this.workspace ||
					!withinRoot(this.workspace, op.target)
				)
					return Promise.resolve(noRead());
				const signal = AbortSignal.any([
					runSignal,
					this.controller.signal,
					AbortSignal.timeout(12_000),
				]);
				const task = this.readerTail.then(async () => {
					if (
						signal.aborted ||
						this.readerBlocked ||
						(await identity(this.workspace)) !== before
					)
						return noRead();
					try {
						return await this.reader.read(
							this.name,
							this.workspace,
							image,
							op,
							signal,
						);
					} catch (error) {
						this.readerBlocked = true;
						this.handle?.requestStop("Workspace reader cleanup unconfirmed");
						throw error;
					}
				});
				this.readerTail = task.then(
					() => {},
					() => {},
				);
				return task;
			},
		};
	}

	private async mutate(
		op: PreparedWorkspaceOperation,
		runSignal: AbortSignal,
		before: string,
		artifact?: string,
	): Promise<ToolResult> {
		const writer = this.writer;
		if (
			!writer ||
			!artifact ||
			++this.toolCalls > maxFiles ||
			!canMutate(op.name) ||
			op.cwd !== this.workspace ||
			op.target === this.workspace ||
			!withinRoot(this.workspace, op.target)
		)
			throw new Error("Prepared workspace mutation is not available");
		const signal = AbortSignal.any([runSignal, this.controller.signal]);
		const task = this.readerTail.then(async () => {
			signal.throwIfAborted();
			if (this.readerBlocked || (await identity(this.workspace)) !== before)
				throw new Error("Workspace no longer matches the admitted mount");
			signal.throwIfAborted();
			return writer.mutate(this.name, this.workspace, artifact, op, signal);
		});
		this.readerTail = task.then(
			() => {},
			() => {
				// Keep a lost acknowledgment unknown in Core. Never try another
				// execution backend or reuse this run's executor queue.
				this.readerBlocked = true;
			},
		);
		return task;
	}

	private async run() {
		const signal = this.controller.signal;
		const before = await identity(this.workspace);
		const image = await this.reader.admit();
		this.readerAdmitted = true;
		signal.throwIfAborted();
		if (!/^sha256:[a-f0-9]{64}$/.test(image))
			throw new Error("Isolated reader image identity is invalid");
		const writerImage = await this.writer?.admit();
		if (this.writer) {
			if (!writerImage || !/^sha256:[a-f0-9]{64}$/.test(writerImage))
				throw new Error("Isolated writer image identity is invalid");
			this.writerAdmitted = true;
		}
		signal.throwIfAborted();
		const readinessImage = await this.commandProbe?.admit();
		if (this.commandProbe && !readinessImage)
			throw new Error("Isolated readiness image identity is invalid");
		const readiness = readinessImage
			? this.readinessAdapter(readinessImage, before)
			: undefined;
		this.readinessAdmitted = readiness !== undefined;
		signal.throwIfAborted();
		const api = await import("@cybergarage/orbit");
		const repo = await hostRepository(this.core);
		const found = await repo.findById(this.config.sessionId);
		if (
			!found ||
			found.cwd !== this.workspace ||
			found.originator !== hostOriginator
		)
			throw new Error(
				"Session does not belong to this host profile and selected workspace",
			);
		this.session = repo.open(found.file);
		let terminalReported = false;
		try {
			this.session.selectModel({
				model: this.config.model,
				provider: this.config.provider,
			});
			const { createWorkerModel } = await import("../worker/models.mjs");
			const model = createWorkerModel(this.config, (route, body) => {
				if (++this.providerCalls > 32)
					return Promise.reject(new Error("Host provider budget exceeded"));
				return this.request(
					route,
					body,
					AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
				);
			});
			const contextPolicy = await api.createModelContextPolicy(model, {
				outputReserve: 1024,
			});
			signal.throwIfAborted();
			const projectContext = this.config.projectContext;
			this.agent = new api.Agent({
				cwd: this.workspace,
				deps: {
					createModel: () => model,
					// A default empty servers object does not clear inherited settings.
					// Never create a real MCP manager in the Electron process.
					createMcpToolManager: () => ({
						getTools: async () => [],
						close: async () => {},
					}),
				},
				contextPolicy,
				interruptionPolicy: { mode: "disabled" },
				logStore: new api.MemorySessionLogStore(),
				state: new api.State(this.session),
				toolProfile: "none",
				settings: {
					model: this.config.model,
					provider: this.config.provider,
					tools: {
						profile: "none",
						include: [
							...readers,
							...(writerImage ? mutations : []),
							...(readiness ? (["bash"] as const) : []),
						],
						exclude: [],
					},
				},
				...(projectContext
					? { projectMemory: projectMemory(api, projectContext) }
					: {}),
				execution: {
					actionMode: "multiple",
					journalLevel: "file-and-directory-sync",
					journalRoot: path.join(this.core, "runs"),
					limits: {
						elapsedMs: 210_000,
						approvalMs: 60_000,
						modelCalls: 9,
						toolRounds: 8,
						toolRequests: maxFiles,
						cleanupMs: 3_000,
						mcpServers: 0,
					},
					policy: {
						generation: [
							writerImage
								? `orbit-app-host-files-v1:${writerImage}`
								: "orbit-app-host-readonly-v1",
							...(readinessImage ? [`probe:${readinessImage}`] : []),
						].join(":"),
						profile: "workspace-confirm",
						roots: [this.workspace],
						decide: (op) => {
							if (op.effect === "command" && op.name === "bash")
								return readiness &&
									!this.readinessUsed &&
									readinessInput(op.input)
									? "ask"
									: "deny";
							if (op.effect === "write" && writerImage && canMutate(op.name))
								return "ask";
							const input = op.input as
								| { pattern?: unknown; glob?: unknown }
								| undefined;
							return op.effect === "read" &&
								canRead(op.name) &&
								(op.name !== "glob" || selectedPattern(input?.pattern)) &&
								(op.name !== "grep" || selectedPattern(input?.glob))
								? "allow"
								: "deny";
						},
					},
					workspaceExecutor: this.fileRunner(
						image,
						before,
						writerImage,
						readiness,
					),
					...(writerImage || readiness
						? {
								responderScope: "desktop-owner",
								onApproval: (request: HostApproval) => {
									if (signal.aborted) return;
									this.approval = request;
									this.event({
										type: "approval",
										data: {
											...request,
											preview: {
												...request.preview,
												execution:
													typeof request.preview.command === "string"
														? "Fixed Docker readiness probe; selected workspace read-only; no network"
														: "Isolated Docker writer; selected workspace only",
											},
										},
									});
								},
							}
						: {}),
				},
			});
			// Remove inert inherited settings from the host run's journal as well.
			this.agent.settings.mcp = { servers: {} };
			delete this.agent.settings.providers;
			signal.throwIfAborted();
			this.handle = await this.agent.startRun(
				[new api.Message("user", { content: this.config.prompt })],
				{
					requestId: this.config.requestId,
					...(projectContext ? { memory: { mode: "automatic" } } : {}),
					maxToolIterations: 8,
					onEvent: (event) => this.event({ type: "agent-event", data: event }),
					onRunSnapshot: (snapshot) =>
						this.event({ type: "run", data: snapshot }),
				},
			);
			if (signal.aborted) this.handle.requestStop("User cancelled");
			const runtime = await this.handle.finished;
			terminalReported = true;
			this.event({
				type: "result",
				data: {
					runtime,
					answer: this.handle.value()?.content ?? "",
					entries: this.session.getEntries(),
				},
			});
		} catch (error) {
			if (signal.aborted)
				this.event({
					type: "model-cancelled",
					data: { reason: "host cancellation" },
				});
			throw error;
		} finally {
			this.approval = undefined;
			await this.closeSession(this.session, terminalReported);
		}
	}

	private async closeSession(session: Session, terminalReported: boolean) {
		try {
			await this.agent?.close();
		} catch (error) {
			// An unknown effect can retain Core's managed lease indefinitely.
			// Do not wait on it here or clear it. The supervisor must verify
			// the owner marker and keep recovery blocked.
			void session.close().catch(() => {});
			if (!terminalReported) throw error;
			this.event({ type: "cleanup-error", data: String(error) });
			return;
		}
		await session.close();
	}
}

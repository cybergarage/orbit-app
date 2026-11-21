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
} from "@cybergarage/orbit";
import { hostOriginator, hostRepository } from "./host-core";
import {
	admitWorkspaceReaderImage,
	command,
	dockerPath,
	dockerWorkspaceArgs,
	stopWorkerWorkspaceMutation,
	verifySessionWriterReleased,
} from "./worker";
import { executeWorkspaceObservation } from "./workspace-mutation-client";

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

/** Runs Core in the host; only the built-in read tools are visible. */
export class HostAgentRun {
	readonly name = `orbit-app-${randomUUID()}`; // used solely for reader ownership
	readonly workspaceMutationsEnabled = false;
	readonly workspaceReadsEnabled = true;
	private readonly controller = new AbortController();
	private agent?: Agent;
	private session?: Session;
	private handle?: Awaited<ReturnType<Agent["startRun"]>>;
	private running?: Promise<void>;
	private readerAdmitted = false;
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
	) {}

	approve(_id: unknown, _approval: unknown) {
		throw new Error("Host development mode has no mutable or command tools");
	}

	start() {
		this.running ??= this.run();
		return this.running;
	}

	async stop() {
		this.controller.abort();
		this.handle?.requestStop("User cancelled");
		await this.running?.catch(() => {});
	}

	async confirmGone() {
		await this.readerTail;
		if (this.readerAdmitted) await this.reader.stop(this.name);
		await verifySessionWriterReleased(this.core, this.config.sessionId);
	}

	private readOnlyRunner(image: string, before: string): WorkspaceExecutor {
		return {
			toolNames: readers,
			execute: (op, runSignal) => {
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

	private async run() {
		const signal = this.controller.signal;
		const before = await identity(this.workspace);
		const image = await this.reader.admit();
		this.readerAdmitted = true;
		signal.throwIfAborted();
		if (!/^sha256:[a-f0-9]{64}$/.test(image))
			throw new Error("Isolated reader image identity is invalid");
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
					tools: { profile: "none", include: [...readers], exclude: [] },
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
						generation: "orbit-app-host-readonly-v1",
						profile: "workspace-confirm",
						roots: [this.workspace],
						decide: (op) => {
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
					workspaceExecutor: this.readOnlyRunner(image, before),
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
			try {
				await this.agent?.close();
			} finally {
				await this.session.close();
			}
		}
	}
}

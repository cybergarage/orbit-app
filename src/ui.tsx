import { InitializationSettings } from "./initialization-settings";
import { orderedChats } from "./chat-order";
import { ScheduleEditor } from "./schedule-editor";
import { describeRepeat, scheduledTime } from "./scheduling";
import { useState, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot, EventRecord, Schedule } from "./types";
import "./ui.css";
function NativeDialog({
	children,
	label,
	onDismiss,
}: {
	readonly children: ReactNode;
	readonly label: string;
	readonly onDismiss: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		<dialog
			className="modal"
			ref={dialog}
			aria-label={label}
			onCancel={(event) => {
				event.preventDefault();
				onDismiss();
			}}
			onClose={onDismiss}
		>
			{children}
		</dialog>
	);
}
function eventContent(event: EventRecord) {
	if (event.type === "submission") return event.data.prompt;
	if (event.type === "result") {
		return (
			event.data.answer ||
			"No answer was returned. Check the task status and open Debug for details."
		);
	}
	if (typeof event.data === "string") return event.data;
	return JSON.stringify(event.data, null, 2);
}
function eventLabel(event: EventRecord, raw: boolean) {
	if (raw) return event.type;
	return event.type === "submission" ? "YOU" : "ORBIT";
}
function eventDisplayContent(event: EventRecord, raw: boolean) {
	if (raw) return JSON.stringify(event, null, 2);
	if (event.type === "error")
		return "The task could not finish. Your conversation is saved. Check the runtime connection and retry when it is ready. Open Debug for details.";
	if (event.type === "cancel-requested")
		return "Stop requested. Wait for the worker to finish before submitting again.";
	return eventContent(event);
}
function Events({
	events,
	raw = false,
}: {
	readonly events: readonly EventRecord[];
	readonly raw?: boolean;
}) {
	return (
		<>
			{events
				.filter(
					(e) =>
						raw ||
						[
							"submission",
							"result",
							"error",
							"interrupted",
							"cancel-requested",
							"approval-decision",
						].includes(e.type),
				)
				.map((e, i) => (
					<article
						key={e.id ?? i}
						className={e.type === "submission" ? "user" : "agent"}
					>
						<small>{eventLabel(e, raw)}</small>
						<pre>{eventDisplayContent(e, raw)}</pre>
					</article>
				))}
		</>
	);
}
function App() {
	function renderScheduledContent() {
		function renderExecutionHistory() {
			if (execution) {
				return (
					<>
						<button type="button" onClick={() => setRunId("")}>
							Back to execution history
						</button>
						<h2>Execution details</h2>
						<p>
							{execution.status} · {execution.projectName} · {execution.model}
						</p>
						<p>
							Due {new Date(execution.dueAt).toLocaleString()} · Started{" "}
							{new Date(execution.startedAt).toLocaleString()}
						</p>
						<small>
							Occurrence {execution.id} · Request {execution.requestId} · Orbit
							run {execution.orbitRunId ?? "Not admitted"}
						</small>
						<div className="card">
							<strong>Input</strong>
							<pre>{execution.prompt}</pre>
						</div>
						<div className="card">
							<strong>Answer</strong>
							<pre>{execution.answer ?? "No answer yet"}</pre>
						</div>
						<Events events={execution.events} raw />
					</>
				);
			}
			if (!state.executions?.length) {
				return (
					<div className="card">
						<h2>No executions yet</h2>
						<p>Execution history appears after a scheduled task becomes due.</p>
					</div>
				);
			}
			return (
				<table>
					<thead>
						<tr>
							<th>Started</th>
							<th>Task / project</th>
							<th>Status</th>
							<th>Duration</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						{[...(state.executions ?? [])].reverse().map((r) => (
							<tr key={r.id}>
								<td>{new Date(r.startedAt).toLocaleString()}</td>
								<td>
									<strong>{r.prompt.slice(0, 80)}</strong>
									<small>{r.projectName}</small>
								</td>
								<td>{r.status}</td>
								<td>
									{r.endedAt
										? `${Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))}s`
										: "In progress"}
								</td>
								<td>
									<button type="button" onClick={() => setRunId(r.id)}>
										View details
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			);
		}
		if (history) {
			return renderExecutionHistory();
		}
		if (!state.schedules.length) {
			return (
				<div className="card">
					<h2>No scheduled tasks</h2>
					<p>Create a task to run at a local date and time.</p>
					<button type="button" onClick={() => openSchedule()}>
						+ New task
					</button>
				</div>
			);
		}
		return state.schedules.map((s) => (
			<div className="card" key={s.id}>
				<strong>{s.prompt}</strong>
				<p>
					{state.projects.find((p) => p.id === s.projectId)?.name} · {s.model}
				</p>
				{s.plan && (
					<p>
						First: {scheduledTime(s.plan.firstAt, s.plan.timeZone)} ·{" "}
						{s.plan.timeZone}
					</p>
				)}
				<p>
					{s.enabled
						? `Next: ${s.plan ? `${scheduledTime(s.nextAt, s.plan.timeZone)} · ${s.plan.timeZone}` : new Date(s.nextAt).toLocaleString()}`
						: "Disabled"}{" "}
					·{" "}
					{s.plan
						? describeRepeat(s.plan.repeat)
						: s.intervalMs
							? `Every ${s.intervalMs / 3600000} hours`
							: "One time"}
				</p>
				<button type="button" onClick={() => openSchedule(s)}>
					Edit schedule
				</button>
				<button
					type="button"
					disabled={!s.enabled}
					onClick={() =>
						void action(() =>
							window.orbit.call("disable-schedule", { id: s.id }),
						)
					}
				>
					{s.enabled ? "Disable" : "Disabled"}
				</button>
			</div>
		));
	}

	function sidebarHeading() {
		if (view === "scheduled") {
			return "Scheduled";
		}
		if (view === "settings" || view === "runtime") {
			return "Settings";
		}
		return "Home";
	}

	const [state, setState] = useState<Snapshot>({ projects: [], schedules: [] });
	const [view, setView] = useState("home");
	const [debug, setDebug] = useState(false);
	const [savingName, setSavingName] = useState(false);
	const [projectId, setProject] = useState("");
	const [sessionId, setSession] = useState("");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState({
		expectedRevision: undefined as number | undefined,
		operationId: crypto.randomUUID(),
		name: "",
		directory: "",
		instructions: "",
	});
	const [editing, setEditing] = useState("");
	const [menu, setMenu] = useState<{
		projectId: string;
		sessionId?: string;
		x: number;
		y: number;
	}>();
	const [dialog, setDialog] = useState<"rename" | "move" | "rename-project">();
	const [rename, setRename] = useState("");
	const [target, setTarget] = useState("");
	const [subject, setSubject] = useState<{
		projectId: string;
		sessionId: string;
		expectedRevision?: number;
		operationId?: string;
	}>();
	const [history, setHistory] = useState(false);
	const [runId, setRunId] = useState("");
	const [editingSchedule, setEditingSchedule] = useState<Schedule>();
	const [scheduleGeneration, setScheduleGeneration] = useState(0);
	const [settingsCategory, setSettingsCategory] = useState("appearance");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [systemDark, setSystemDark] = useState(
		matchMedia("(prefers-color-scheme: dark)").matches,
	);
	const dark =
		state.appearance === "dark" || (state.appearance !== "light" && systemDark);
	useEffect(() => {
		document.documentElement.dataset.appearance = state.appearance ?? "system";
	}, [state.appearance]);
	useEffect(() => {
		const query = matchMedia("(prefers-color-scheme: dark)");
		const update = () => setSystemDark(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	function openSchedule(schedule?: Schedule) {
		setEditingSchedule(schedule);
		setScheduleGeneration((value) => value + 1);
		setError("");
		setView("schedule");
	}
	const [artifacts, setArtifacts] = useState<string[]>([]);
	useEffect(() => {
		void window.orbit.call("snapshot").then(setState);
		return window.orbit.subscribe(setState);
	}, []);
	useEffect(() => {
		const close = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setMenu(undefined);
				setDialog(undefined);
			}
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, []);
	const project = state.projects.find((p) => p.id === projectId);
	const session = project?.sessions.find((s) => s.id === sessionId);
	const chosenModel = model || session?.model || "";
	const selectedModel = chosenModel || state.health?.models[0] || "";
	const active = !!state.active;
	const pending =
		session?.status === "awaiting-approval" &&
		state.active?.sessionId === session.id
			? session.events.findLast((e) => e.type === "approval")?.data
			: undefined;
	const execution = state.executions?.find((r) => r.id === runId);
	async function action(fn: () => Promise<unknown>) {
		setError("");
		try {
			return await fn();
		} catch (e) {
			setError(String(e));
			void window.orbit
				.call("snapshot")
				.then(setState)
				.catch(() => {});
		}
	}
	function openSession(p: string, s: string) {
		setProject(p);
		setSession(s);
		setView("home");
		setArtifacts([]);
		const opened = state.projects
			.find((item) => item.id === p)
			?.sessions.find((item) => item.id === s);
		setPrompt(
			opened && ["failed", "cancelled", "interrupted"].includes(opened.status)
				? (opened.events.findLast((event) => event.type === "submission")?.data
						.prompt ?? "")
				: "",
		);
		setModel("");
	}
	function newProject() {
		setEditing("");
		setForm({
			name: "",
			directory: "",
			instructions: "",
			expectedRevision: undefined,
			operationId: crypto.randomUUID(),
		});
		setView("project");
	}
	async function newChat(id = project?.unassigned ? "" : project?.id) {
		await action(async () => {
			const s = await window.orbit.call("create-session", {
				projectId: id,
			});
			openSession(s.projectId, s.id);
			setCollapsed((current) => {
				const next = new Set(current);
				next.delete(s.projectId);
				return next;
			});
		});
	}
	const lastSubmission = session?.events.findLast(
		(e) => e.type === "submission",
	);
	const retryable =
		!!session &&
		["failed", "cancelled", "interrupted"].includes(session.status);
	const taskInput = prompt;
	useEffect(() => {
		if (retryable) setPrompt(lastSubmission?.data.prompt ?? "");
	}, [retryable, lastSubmission?.data.prompt]);
	async function submit() {
		if (busy || active || !taskInput.trim() || !selectedModel) return;
		setBusy(true);
		await action(async () => {
			let p = projectId,
				s = sessionId;
			if (!session) {
				const created = await window.orbit.call("create-session", {
					projectId: p,
				});
				p = created.projectId;
				s = created.id;
				setProject(p);
				setSession(s);
			}
			await window.orbit.call("submit", {
				projectId: p,
				sessionId: s,
				prompt: taskInput,
				model: selectedModel,
				requestId: crypto.randomUUID(),
			});
			setPrompt("");
		});
		setBusy(false);
	}
	function showMenu(e: React.MouseEvent, p: string, s?: string) {
		e.preventDefault();
		setMenu({
			projectId: p,
			sessionId: s,
			x: Math.min(e.clientX, window.innerWidth - 304),
			y: Math.min(e.clientY, window.innerHeight - 220),
		});
	}
	const locked =
		menu?.sessionId &&
		(state.active?.sessionId === menu.sessionId ||
			[
				"starting",
				"running",
				"awaiting-approval",
				"cancelling",
				"recovery-blocked",
			].includes(
				state.projects
					.find((p) => p.id === menu.projectId)
					?.sessions.find((s) => s.id === menu.sessionId)?.status ?? "",
			));
	const checks = state.health
		? [state.health.ollama, state.health.docker, state.health.image].filter(
				Boolean,
			).length
		: undefined;
	const composer = (
		<div className="composer">
			<textarea
				aria-label="Task"
				value={taskInput}
				onChange={(e) => setPrompt(e.target.value)}
				placeholder="Ask anything…"
				maxLength={12000}
			/>
			<div>
				<label>
					Model{" "}
					<select
						aria-label="Model"
						value={selectedModel}
						disabled={active || busy}
						onChange={(e) => {
							setModel(e.target.value);
							if (session)
								void action(() =>
									window.orbit.call("select-model", {
										projectId,
										sessionId,
										model: e.target.value,
									}),
								);
						}}
					>
						<option value="">Select an installed model</option>
						{[
							...new Set([
								...(state.health?.models ?? []),
								...(chosenModel ? [chosenModel] : []),
							]),
						].map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</label>
				{active || busy ? (
					<button
						type="button"
						className="stop"
						onClick={() => void action(() => window.orbit.call("cancel"))}
					>
						Stop worker
					</button>
				) : (
					<button
						type="button"
						className="primary"
						disabled={!taskInput.trim() || !selectedModel}
						onClick={() => void submit()}
					>
						{retryable ? "Retry task ↗" : "Run task ↗"}
					</button>
				)}
			</div>
		</div>
	);
	function renderProjectEditor() {
		return (
			view === "project" && (
				<section className="page project-form">
					<h1>{editing ? "Edit project" : "New project"}</h1>
					<p>
						Create a space for related chats. Only the project name is required.
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void action(async () => {
								const p = await window.orbit.call(
									editing ? "edit-project" : "create-project",
									{ ...form, projectId: editing },
								);
								setProject(p.id);
								setSession("");
								setView("home");
							});
						}}
					>
						<label htmlFor="project-name">Project name *</label>
						<input
							id="project-name"
							value={form.name}
							required
							maxLength={80}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
						/>
						<p>A name that's easy to find in the sidebar.</p>
						<label htmlFor="directory">Working directory · optional</label>
						<input
							id="directory"
							placeholder="Use app-managed workspace"
							value={form.directory}
							onChange={(e) => setForm({ ...form, directory: e.target.value })}
						/>
						<p>
							Use an existing absolute local directory, or leave blank.
							Directory changes apply only to new chats; existing chats keep
							their working directory.
						</p>
						<label htmlFor="instructions">Instructions · optional</label>
						<textarea
							id="instructions"
							value={form.instructions}
							maxLength={12000}
							onChange={(e) =>
								setForm({ ...form, instructions: e.target.value })
							}
						/>
						<p>
							Applied to future tasks in this project alongside workspace
							ORBIT.md / AGENTS.md guidance.
						</p>
						<div className="actions">
							<button
								type="submit"
								className="primary"
								disabled={!form.name.trim()}
							>
								{editing ? "Save project" : "Create project"}
							</button>
							<button type="button" onClick={() => setView("home")}>
								Cancel
							</button>
						</div>
					</form>
				</section>
			)
		);
	}
	function renderRuntime() {
		return (
			(view === "runtime" ||
				(view === "settings" && settingsCategory === "status")) && (
				<section className="page status-page">
					<h1>Status</h1>
					<p>
						Local execution environment. Model selection is saved for each
						conversation.
					</p>
					<div className="notice">
						<strong>
							{checks === undefined
								? "Connections not checked"
								: `${checks}/3 checks passed`}
						</strong>
						<p>
							{state.health?.checkedAt
								? `Last checked ${new Date(state.health.checkedAt).toLocaleString()}`
								: "Recheck to inspect this Mac."}
						</p>
					</div>
					<div className="card">
						<small>Local model</small>
						<p>
							{state.health?.models.length
								? state.health.models.join(", ")
								: "No installed models reported"}
						</p>
						<small>
							Installed models only. Orbit does not download models
							automatically.
						</small>
					</div>
					{[
						[
							"Ollama",
							state.health?.ollama,
							"The local model service uses 127.0.0.1:11434. Select an installed tool-capable model in the conversation.",
						],
						[
							"Docker daemon",
							state.health?.docker,
							"Runs the isolated worker with no network or privileged capabilities.",
						],
						[
							"Worker image",
							state.health?.image,
							"orbit-app-worker:core-0.9.2 · Orbit 0.9.2. Image readiness does not mean a worker is currently running.",
						],
					].map(([label, ready, detail]) => (
						<div className="card" key={String(label)}>
							<strong>
								{label} · {(() => {
									if (ready === undefined) {
										return "Not checked";
									}
									if (ready) {
										return "Available";
									}
									return "Unavailable";
								})()}
							</strong>
							<p>{detail}</p>
						</div>
					))}
					{state.recoveryBlocked && (
						<output className="error">
							Previous worker recovery is pending. Reconnect Docker before
							starting or moving this chat.
						</output>
					)}
					{state.health?.detail.map((d) => (
						<pre key={d}>{d}</pre>
					))}
					<div className="actions">
						<button
							type="button"
							className="primary"
							onClick={() => void action(() => window.orbit.call("health"))}
						>
							Recheck
						</button>
						<button type="button" onClick={() => setView("home")}>
							Back to Home
						</button>
					</div>
				</section>
			)
		);
	}
	function renderConversation() {
		return (
			view === "home" && (
				<section
					className={`conversation ${!session ? "empty" : ""} ${debug ? "debug-open" : ""}`}
				>
					{session ? (
						<>
							<header>
								<div>
									<h1>{session.name}</h1>
									<small>
										{project?.unassigned ? "Chats" : project?.name} /{" "}
										{session.name}
									</small>
								</div>
								<button
									type="button"
									className={`icon-button ${debug ? "selected" : ""}`}
									aria-label="Debug"
									aria-expanded={debug}
									aria-controls="debug-pane"
									onClick={() => setDebug(!debug)}
								>
									<img src="assets/debug.svg" alt="" />
								</button>
							</header>
							<div className="conversation-body">
								<div className="chat-content">
									<div className="chat-status">
										<strong>{session.name}</strong>
										<small>{session.status}</small>
										{session.autoTitle?.stage === "generating" && (
											<small role="status">Generating title…</small>
										)}
									</div>
									<div className="timeline">
										<Events events={session.events} />
										{!session.events.length && (
											<p>No messages yet. Describe a task below.</p>
										)}
									</div>
									{pending && (
										<div className="approval">
											<strong>Review operation</strong>
											<pre>{JSON.stringify(pending.preview, null, 2)}</pre>
											<div className="actions">
												{[true, false].map((approve) => (
													<button
														type="button"
														key={String(approve)}
														onClick={() =>
															void action(() =>
																window.orbit.call("approve", {
																	id: pending.id,
																	approve,
																}),
															)
														}
													>
														{approve ? "Approve" : "Deny"}
													</button>
												))}
											</div>
										</div>
									)}
									{composer}
								</div>
								{debug && (
									<section
										id="debug-pane"
										className="debug-pane"
										aria-label="Debug details"
									>
										<div className="debug-heading">
											<span>Debug</span>
											<button
												type="button"
												className="icon-button"
												aria-label="Close Debug"
												onClick={() => setDebug(false)}
											>
												<img src="assets/close.svg" alt="" />
											</button>
										</div>
										<p>Current chat · {session.name}</p>
										<small>EVENT LOG</small>
										<div className="debug-events">
											<Events events={session.events} raw />
										</div>
										<small>Logs are retained when Debug is turned off.</small>
										<details>
											<summary>Working directory</summary>
											<small>{session.workspace}</small>
										</details>
										<p>Workspace files</p>
										{artifacts.length ? (
											artifacts.map((f) => <small key={f}>{f}</small>)
										) : (
											<small>No files listed</small>
										)}
										<button
											type="button"
											onClick={() =>
												void action(async () =>
													setArtifacts(
														await window.orbit.call("artifacts", {
															projectId,
															sessionId,
														}),
													),
												)
											}
										>
											Refresh files
										</button>
										<button type="button" onClick={() => openSchedule()}>
											Schedule this task
										</button>
										<small>
											Approvals and important failures remain visible in the
											conversation.
										</small>
									</section>
								)}
							</div>
							<small className="conversation-footer">
								Workspaces persist; active tasks stop when the app exits.
							</small>
						</>
					) : (
						<div className="welcome">
							<h1>What can I help with?</h1>
							<p>
								{project
									? `Start a conversation in ${project.name}.`
									: "Start a conversation, or open a project from the sidebar."}
							</p>
							{composer}
							<small>
								Tasks run locally in an isolated worker. Review writes and
								commands before they execute.
							</small>
						</div>
					)}
				</section>
			)
		);
	}
	function renderScheduleEditor() {
		return (
			view === "schedule" && (
				<ScheduleEditor
					key={`${editingSchedule?.id ?? "new"}-${scheduleGeneration}`}
					existing={editingSchedule}
					prompt={prompt}
					model={selectedModel}
					models={Array.from(
						new Set([
							...(state.health?.models ?? []),
							...(selectedModel ? [selectedModel] : []),
						]),
					)}
					onCancel={() => setView("scheduled")}
					onSave={async (value) => {
						let p = editingSchedule?.projectId ?? projectId,
							id = editingSchedule?.sessionId ?? sessionId;
						if (!id) {
							const created = await window.orbit.call("create-session", {
								projectId: p,
							});
							p = created.projectId;
							id = created.id;
							setProject(p);
							setSession(id);
						}
						await window.orbit.call(
							editingSchedule ? "update-schedule" : "schedule",
							{
								...value,
								id: editingSchedule?.id,
								projectId: p,
								sessionId: id,
							},
						);
						setHistory(false);
						setView("scheduled");
					}}
				/>
			)
		);
	}

	function renderScheduled() {
		return (
			view === "scheduled" && (
				<section className="page">
					<h1>Scheduled</h1>
					<p>Schedule definitions and the outcome of each execution.</p>
					<div className="actions">
						<button
							type="button"
							className={!history ? "selected" : ""}
							onClick={() => {
								setHistory(false);
								setRunId("");
							}}
						>
							Schedules
						</button>
						<button
							type="button"
							className={history ? "selected" : ""}
							onClick={() => {
								setHistory(true);
								setRunId("");
							}}
						>
							Execution history
						</button>
					</div>
					<div className="notice">
						<strong>Runs while Orbit App is open</strong>
						<p>
							Closing the app stops active work. No background OS service is
							installed. Times use each schedule's saved time zone.
						</p>
					</div>
					{renderScheduledContent()}
				</section>
			)
		);
	}
	function renderContextMenu() {
		return (
			menu && (
				<>
					<div
						className="menu-scrim"
						onPointerDown={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setMenu(undefined);
						}}
					/>
					<div
						className="context-menu"
						role="menu"
						style={{ left: menu.x, top: menu.y }}
					>
						<strong>
							{state.projects
								.find((p) => p.id === menu.projectId)
								?.sessions.find((s) => s.id === menu.sessionId)?.name ??
								state.projects.find((p) => p.id === menu.projectId)?.name}
						</strong>
						{menu.sessionId ? (
							<>
								{["rename", "move"].map((command) => (
									<button
										type="button"
										key={command}
										aria-label={
											command === "rename" ? "Rename" : "Move to project"
										}
										role="menuitem"
										disabled={!!locked}
										onClick={() => {
											setSubject({
												projectId: menu.projectId,
												sessionId: menu.sessionId ?? "",
												expectedRevision: state.projects
													.find((p) => p.id === menu.projectId)
													?.sessions.find((s) => s.id === menu.sessionId)
													?.nameRevision,
												operationId: crypto.randomUUID(),
											});
											setRename(
												state.projects
													.find((p) => p.id === menu.projectId)
													?.sessions.find((s) => s.id === menu.sessionId)
													?.name ?? "",
											);
											setTarget("");
											setDialog(command as "rename" | "move");
											setMenu(undefined);
										}}
									>
										{(() => {
											if (command === "rename") {
												return "Rename chat…";
											}
											if (locked) {
												return "Move unavailable";
											}
											return "Move to project…";
										})()}
									</button>
								))}
								{locked && (
									<small>Unavailable while running or awaiting recovery.</small>
								)}
							</>
						) : (
							<>
								<button
									type="button"
									role="menuitem"
									aria-label="Rename"
									onClick={() => {
										setSubject({
											projectId: menu.projectId,
											sessionId: "",
											expectedRevision: state.projects.find(
												(p) => p.id === menu.projectId,
											)?.nameRevision,
											operationId: crypto.randomUUID(),
										});
										setRename(
											state.projects.find((p) => p.id === menu.projectId)
												?.name ?? "",
										);
										setDialog("rename-project");
										setMenu(undefined);
									}}
								>
									Rename project…
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										const p = state.projects.find(
											(p) => p.id === menu.projectId,
										);
										if (p) {
											setEditing(p.id);
											setForm({
												expectedRevision: p.nameRevision,
												operationId: crypto.randomUUID(),
												name: p.name,
												directory: p.directory ?? "",
												instructions: p.instructions ?? "",
											});
											setView("project");
										}
										setMenu(undefined);
									}}
								>
									Edit project
								</button>
							</>
						)}
					</div>
				</>
			)
		);
	}
	function renderSessionDialog() {
		if (dialog && dialog !== "move" && subject) {
			const isProject = dialog === "rename-project";
			return (
				<section className="page project-form rename-page">
					<h1>{isProject ? "Rename project" : "Rename chat"}</h1>
					<p>
						{isProject
							? "Change the project label in the sidebar."
							: "Change the conversation title."}
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (savingName) return;
							setSavingName(true);
							void action(async () => {
								if (isProject)
									await window.orbit.call("rename-project", {
										...subject,
										name: rename,
									});
								else
									await window.orbit.call("rename-session", {
										...subject,
										name: rename,
									});
								setDialog(undefined);
							}).finally(() => setSavingName(false));
						}}
					>
						<label htmlFor="rename-name">
							{isProject ? "Project name *" : "Chat name *"}
						</label>
						<input
							id="rename-name"
							value={rename}
							required
							maxLength={80}
							onChange={(e) => setRename(e.target.value)}
						/>
						{isProject && (
							<p>
								Name is required. This does not change the working directory.
							</p>
						)}
						<div className="actions">
							<button
								className="primary"
								type="submit"
								disabled={!rename.trim() || savingName}
							>
								Save name
							</button>
							<button type="button" onClick={() => setDialog(undefined)}>
								Cancel
							</button>
						</div>
					</form>
				</section>
			);
		}
		return (
			dialog &&
			subject && (
				<NativeDialog label="Move chat" onDismiss={() => setDialog(undefined)}>
					<section>
						<h2>Move chat</h2>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void action(async () => {
									const result = await window.orbit.call("move-session", {
										...subject,
										name: rename,
										targetProjectId: target,
									});
									if (dialog === "move" && sessionId === subject.sessionId)
										setProject(result.projectId);
									setDialog(undefined);
								});
							}}
						>
							<label>
								Destination{" "}
								<select
									aria-label="Destination project"
									value={target}
									onChange={(e) => setTarget(e.target.value)}
								>
									<option value="">Chats · no project</option>
									{state.projects
										.filter((p) => !p.unassigned && p.id !== subject.projectId)
										.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name}
											</option>
										))}
								</select>
							</label>
							<p>
								History, files and working directory stay in their original
								location. Future tasks use the destination project's
								instructions. Linked schedules follow this chat.
							</p>
							<div className="actions">
								<button type="submit" className="primary">
									Move chat
								</button>
								<button type="button" onClick={() => setDialog(undefined)}>
									Cancel
								</button>
							</div>
						</form>
					</section>
				</NativeDialog>
			)
		);
	}
	return (
		<div className="app">
			<nav className="dock" aria-label="Primary navigation">
				{["Home", "Scheduled", "Settings"].map((v) => (
					<button
						type="button"
						key={v}
						className={view === v.toLowerCase() ? "selected" : ""}
						onClick={() => {
							setView(v.toLowerCase());
							if (v === "Settings") setSettingsCategory("appearance");
							if (v === "Home") {
								setProject("");
								setSession("");
							}
						}}
					>
						<img
							src={`assets/${v.toLowerCase()}${dark ? "-dark" : ""}.svg`}
							alt=""
						/>
						{v}
					</button>
				))}
			</nav>
			<aside
				className={
					view === "settings" || view === "runtime"
						? "settings-sidebar"
						: "home-sidebar"
				}
			>
				<h2>{sidebarHeading()}</h2>
				{view === "settings" || view === "runtime" ? (
					<>
						<button
							className={
								settingsCategory === "appearance" && view !== "runtime"
									? "selected"
									: ""
							}
							onClick={() => {
								setView("settings");
								setSettingsCategory("appearance");
							}}
						>
							Appearance
						</button>
						<button
							className={
								settingsCategory === "status" || view === "runtime"
									? "selected"
									: ""
							}
							onClick={() => {
								setView("settings");
								setSettingsCategory("status");
							}}
						>
							Status
						</button>
						<button
							type="button"
							className={
								settingsCategory === "initialization" ? "selected" : ""
							}
							onClick={() => {
								setView("settings");
								setSettingsCategory("initialization");
							}}
						>
							Initialization
						</button>
					</>
				) : view === "scheduled" || view === "schedule" ? (
					<>
						<button
							type="button"
							onClick={() => {
								openSchedule();
								setPrompt("");
							}}
						>
							+ New task
						</button>
						<small className="section-label">UPCOMING</small>
						{state.schedules
							.filter((s) => s.enabled)
							.map((s) => (
								<button
									type="button"
									key={s.id}
									onClick={() => {
										setHistory(false);
										setView("scheduled");
									}}
								>
									{s.prompt.slice(0, 40)}
									<small>{new Date(s.nextAt).toLocaleString()}</small>
								</button>
							))}
						{!state.schedules.some((s) => s.enabled) && (
							<small>No scheduled tasks</small>
						)}
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => {
								setProject("");
								setSession("");
								setPrompt("");
								setModel("");
								setView("home");
							}}
						>
							+ New chat
						</button>
						<small className="section-label">PROJECTS</small>
						<button type="button" onClick={newProject}>
							+ New project
						</button>
						{state.projects
							.filter((p) => !p.unassigned)
							.map((p) => (
								<div key={p.id} className="project-group">
									<div className="row">
										<button
											type="button"
											aria-expanded={!collapsed.has(p.id)}
											aria-label={`Project ${p.name}`}
											className={
												projectId === p.id
													? "selected project-toggle"
													: "project-toggle"
											}
											onClick={() => {
												setCollapsed((current) => {
													const next = new Set(current);
													if (projectId === p.id && !next.has(p.id))
														next.add(p.id);
													else next.delete(p.id);
													return next;
												});
												setProject(p.id);
												setSession("");
												setView("home");
											}}
										>
											<img
												className="folder-icon"
												src={`assets/folder-${collapsed.has(p.id) ? "closed" : "open"}.svg`}
												alt=""
											/>
											<span className="project-label">{p.name}</span>
										</button>
										<button
											type="button"
											className="icon-button"
											aria-label={`New chat in ${p.name}`}
											onClick={() => void newChat(p.id)}
										>
											<img src="assets/new-chat.svg" alt="" />
										</button>
										<button
											type="button"
											aria-label={`Project menu ${p.name}`}
											onClick={(e) => showMenu(e, p.id)}
										>
											<img src="assets/more.svg" alt="" />
										</button>
									</div>
									{!collapsed.has(p.id) &&
										orderedChats(p.sessions).map((s) => (
											<div className="row session-row" key={s.id}>
												<button
													type="button"
													className={sessionId === s.id ? "selected" : ""}
													onContextMenu={(e) => showMenu(e, p.id, s.id)}
													onClick={() => openSession(p.id, s.id)}
												>
													{s.name}
													{s.autoTitle?.stage === "generating" && (
														<small role="status">Generating title…</small>
													)}
												</button>
												<button
													type="button"
													aria-label={`Chat menu ${s.name}`}
													onClick={(e) => showMenu(e, p.id, s.id)}
												>
													<img src="assets/more.svg" alt="" />
												</button>
											</div>
										))}
								</div>
							))}
						<small className="section-label">CHATS</small>
						{state.projects
							.filter((p) => p.unassigned)
							.flatMap((p) =>
								orderedChats(p.sessions).map((s) => (
									<div className="row" key={s.id}>
										<button
											type="button"
											className={sessionId === s.id ? "selected" : ""}
											onContextMenu={(e) => showMenu(e, p.id, s.id)}
											onClick={() => openSession(p.id, s.id)}
										>
											{s.name}
											{s.autoTitle?.stage === "generating" && (
												<small role="status">Generating title…</small>
											)}
										</button>
										<button
											type="button"
											aria-label={`Chat menu ${s.name}`}
											onClick={(e) => showMenu(e, p.id, s.id)}
										>
											<img src="assets/more.svg" alt="" />
										</button>
									</div>
								)),
							)}
						<small>Not linked to a project</small>
					</>
				)}
				<div className="sidebar-bottom">
					<small>On this Mac</small>
					{!["settings", "runtime"].includes(view) && (
						<button
							type="button"
							onClick={() => {
								setView("settings");
								setSettingsCategory("status");
							}}
						>
							● Runtime ·{" "}
							{checks === undefined
								? "Not checked"
								: `${checks}/3 checks passed`}{" "}
							›
						</button>
					)}
				</div>
			</aside>
			<main>
				{error && (
					<div role="alert" className="error">
						{error}
					</div>
				)}
				{!dialog && renderProjectEditor()}
				{!dialog &&
					view === "settings" &&
					settingsCategory === "initialization" && <InitializationSettings />}
				{!dialog &&
					view === "settings" &&
					settingsCategory === "appearance" && (
						<section className="page appearance-page">
							<h1>Appearance</h1>
							<p>Make Orbit feel at home.</p>
							<div className="card">
								<strong>Theme</strong>
								<p>Choose how Orbit appears on this device.</p>
								<fieldset className="theme-options" aria-label="Theme">
									{(["system", "light", "dark"] as const).map((value) => (
										<button
											key={value}
											aria-pressed={(state.appearance ?? "system") === value}
											className={`theme-option ${(state.appearance ?? "system") === value ? "selected" : ""}`}
											onClick={() =>
												void action(() =>
													window.orbit.call("appearance", { value }),
												)
											}
										>
											<span
												className={`theme-preview ${value === "dark" ? "preview-dark" : "preview-light"}`}
											>
												<i />
												<i />
												<span>
													<b />
													<em />
													<i />
												</span>
											</span>
											<strong>{value[0].toUpperCase() + value.slice(1)}</strong>
											<small>
												{value === "system"
													? "Follow your device"
													: value === "light"
														? "Warm and bright"
														: "Soft, low-light colors"}
											</small>
										</button>
									))}
								</fieldset>
							</div>
							<div className="card">
								<strong>
									{state.appearance === "dark"
										? "A calmer dark workspace"
										: state.appearance === "light"
											? "A lighter workspace"
											: "In sync with your system"}
								</strong>
								<p>
									{state.appearance === "system" || !state.appearance
										? "System follows your device’s light or dark appearance automatically."
										: "Your preference stays selected when you reopen Orbit App. Switch to System to follow your device automatically."}
								</p>
							</div>
						</section>
					)}
				{!dialog && renderRuntime()}
				{!dialog && renderConversation()}
				{!dialog && renderScheduleEditor()}
				{!dialog && renderScheduled()}
				{renderSessionDialog()}
			</main>
			{renderContextMenu()}
		</div>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

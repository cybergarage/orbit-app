import { useState, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot, EventRecord } from "./types";
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
	if (event.type === "result") return event.data.answer;
	if (typeof event.data === "string") return event.data;
	return JSON.stringify(event.data, null, 2);
}
function Events({ events }: { readonly events: readonly EventRecord[] }) {
	return (
		<>
			{events.map((e, i) => (
				<article
					key={e.id ?? i}
					className={e.type === "submission" ? "user" : "agent"}
				>
					<small>
						{e.type} · {new Date(e.at).toLocaleString()}
					</small>
					<pre>{eventContent(e)}</pre>
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
						<button type="button" onClick={() => setRun("")}>
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
						<Events events={execution.events} />
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
									<button type="button" onClick={() => setRun(r.id)}>
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
					<button type="button" onClick={() => setView("schedule")}>
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
				<p>
					{s.enabled
						? `Next: ${new Date(s.nextAt).toLocaleString()}`
						: "Disabled"}{" "}
					·{" "}
					{s.intervalMs ? `Every ${s.intervalMs / 3600000} hours` : "One time"}
				</p>
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
		if (view === "settings") {
			return "Settings";
		}
		return "Home";
	}

	const [state, setState] = useState<Snapshot>({ projects: [], schedules: [] });
	const [view, setView] = useState("home");
	const [projectId, setProject] = useState("");
	const [sessionId, setSession] = useState("");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState({
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
	const [dialog, setDialog] = useState<"rename" | "move">();
	const [rename, setRename] = useState("");
	const [target, setTarget] = useState("");
	const [subject, setSubject] = useState<{
		projectId: string;
		sessionId: string;
	}>();
	const [history, setHistory] = useState(false);
	const [runId, setRun] = useState("");
	const [when, setWhen] = useState("");
	const [repeat, setRepeat] = useState("0");
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
		}
	}
	function openSession(p: string, s: string) {
		setProject(p);
		setSession(s);
		setView("home");
		setArtifacts([]);
		setPrompt("");
		setModel("");
	}
	function newProject() {
		setEditing("");
		setForm({ name: "", directory: "", instructions: "" });
		setView("project");
	}
	async function newChat() {
		await action(async () => {
			const s = await window.orbit.call("create-session", {
				projectId: project?.unassigned ? "" : project?.id,
			});
			openSession(s.projectId, s.id);
		});
	}
	async function submit() {
		if (busy || active || !prompt.trim() || !selectedModel) return;
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
				prompt,
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
				value={prompt}
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
						disabled={!prompt.trim() || !selectedModel}
						onClick={() => void submit()}
					>
						Run task ↗
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
						Create a space for related sessions. Only the project name is
						required.
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
			(view === "runtime" || view === "settings") && (
				<section className="page">
					<h1>{view === "runtime" ? "Runtime connections" : "Settings"}</h1>
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
							"orbit-app-worker:0.1.0 · Orbit 0.8.1. Image readiness does not mean a worker is currently running.",
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
				<section className={`conversation ${!session ? "empty" : ""}`}>
					{session ? (
						<>
							<header>
								<div>
									<small>{project?.unassigned ? "Chat" : project?.name}</small>
									<h1>{session.name}</h1>
									<small>
										{session.status} · Working directory: {session.workspace}
									</small>
								</div>
								<button type="button" onClick={() => void newChat()}>
									+ Session
								</button>
							</header>
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
							<div className="actions">
								<button type="button" onClick={() => setView("schedule")}>
									Schedule current task
								</button>
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
								{artifacts.map((f) => (
									<small key={f}>{f}</small>
								))}
							</div>
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
				<section className="page project-form">
					<h1>New scheduled task</h1>
					<p>
						Runs only while Orbit App is open. On restart, missed occurrences
						coalesce into one execution. Operations still require approval.
					</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void action(async () => {
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
								await window.orbit.call("schedule", {
									projectId: p,
									sessionId: s,
									prompt,
									model: selectedModel,
									nextAt: new Date(when).getTime(),
									intervalMs: Number(repeat),
								});
								setHistory(false);
								setView("scheduled");
							});
						}}
					>
						<label htmlFor="scheduled-task">Task input</label>
						<textarea
							id="scheduled-task"
							value={prompt}
							required
							maxLength={12000}
							onChange={(e) => setPrompt(e.target.value)}
						/>
						<label>
							Model{" "}
							<select
								aria-label="Schedule model"
								value={selectedModel}
								onChange={(e) => setModel(e.target.value)}
							>
								<option value="">Select an installed model</option>
								{state.health?.models.map((m) => (
									<option key={m}>{m}</option>
								))}
							</select>
						</label>
						<label htmlFor="when">Local date and time</label>
						<input
							id="when"
							type="datetime-local"
							value={when}
							required
							onChange={(e) => setWhen(e.target.value)}
						/>
						<label>
							Recurrence{" "}
							<select
								aria-label="Schedule recurrence"
								value={repeat}
								onChange={(e) => setRepeat(e.target.value)}
							>
								<option value="0">One time</option>
								<option value="3600000">Every hour</option>
								<option value="86400000">Every 24 hours</option>
							</select>
						</label>
						<div className="actions">
							<button
								type="submit"
								className="primary"
								disabled={!prompt.trim() || !selectedModel || !when}
							>
								Schedule task
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
								setRun("");
							}}
						>
							Schedules
						</button>
						<button
							type="button"
							className={history ? "selected" : ""}
							onClick={() => {
								setHistory(true);
								setRun("");
							}}
						>
							Execution history
						</button>
					</div>
					<div className="notice">
						<strong>Runs while Orbit App is open</strong>
						<p>
							Closing the app stops active work. No background OS service is
							installed. All times are local.
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
										disabled={command === "move" && !!locked}
										onClick={() => {
											setSubject({
												projectId: menu.projectId,
												sessionId: menu.sessionId ?? "",
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
												return "Rename session…";
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
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									const p = state.projects.find((p) => p.id === menu.projectId);
									if (p) {
										setEditing(p.id);
										setForm({
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
						)}
					</div>
				</>
			)
		);
	}
	function renderSessionDialog() {
		return (
			dialog &&
			subject && (
				<NativeDialog
					label={dialog === "rename" ? "Rename session" : "Move session"}
					onDismiss={() => setDialog(undefined)}
				>
					<section>
						<h2>{dialog === "rename" ? "Rename session" : "Move session"}</h2>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void action(async () => {
									const result = await window.orbit.call(
										dialog === "rename" ? "rename-session" : "move-session",
										{ ...subject, name: rename, targetProjectId: target },
									);
									if (dialog === "move" && sessionId === subject.sessionId)
										setProject(result.projectId);
									setDialog(undefined);
								});
							}}
						>
							{dialog === "rename" ? (
								<label>
									Name{" "}
									<input
										aria-label="Session name"
										value={rename}
										required
										maxLength={80}
										onChange={(e) => setRename(e.target.value)}
									/>
								</label>
							) : (
								<>
									<label>
										Destination{" "}
										<select
											aria-label="Destination project"
											value={target}
											onChange={(e) => setTarget(e.target.value)}
										>
											<option value="">Chats · no project</option>
											{state.projects
												.filter(
													(p) => !p.unassigned && p.id !== subject.projectId,
												)
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
								</>
							)}
							<div className="actions">
								<button type="submit" className="primary">
									{dialog === "rename" ? "Save name" : "Move session"}
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
							if (v === "Home") {
								setProject("");
								setSession("");
							}
						}}
					>
						<img src={`assets/${v.toLowerCase()}.svg`} alt="" />
						{v}
					</button>
				))}
			</nav>
			<aside>
				<h2>{sidebarHeading()}</h2>
				{view === "scheduled" ? (
					<>
						<button
							type="button"
							onClick={() => {
								setView("schedule");
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
								<div key={p.id}>
									<div className="row">
										<button
											type="button"
											className={projectId === p.id ? "selected" : ""}
											onClick={() => {
												setProject(p.id);
												setSession("");
												setView("home");
											}}
										>
											⌄ {p.name}
										</button>
										<button
											type="button"
											aria-label={`Project menu ${p.name}`}
											onClick={(e) => showMenu(e, p.id)}
										>
											⋯
										</button>
									</div>
									{p.sessions.map((s) => (
										<div className="row session-row" key={s.id}>
											<button
												type="button"
												className={sessionId === s.id ? "selected" : ""}
												onContextMenu={(e) => showMenu(e, p.id, s.id)}
												onClick={() => openSession(p.id, s.id)}
											>
												{s.name}
											</button>
											<button
												type="button"
												aria-label={`Session menu ${s.name}`}
												onClick={(e) => showMenu(e, p.id, s.id)}
											>
												⋯
											</button>
										</div>
									))}
								</div>
							))}
						<small className="section-label">CHATS</small>
						{state.projects
							.filter((p) => p.unassigned)
							.flatMap((p) =>
								p.sessions.map((s) => (
									<div className="row" key={s.id}>
										<button
											type="button"
											className={sessionId === s.id ? "selected" : ""}
											onContextMenu={(e) => showMenu(e, p.id, s.id)}
											onClick={() => openSession(p.id, s.id)}
										>
											{s.name}
										</button>
										<button
											type="button"
											aria-label={`Session menu ${s.name}`}
											onClick={(e) => showMenu(e, p.id, s.id)}
										>
											⋯
										</button>
									</div>
								)),
							)}
						<small>Not linked to a project</small>
					</>
				)}
				<div className="sidebar-bottom">
					<small>On this Mac</small>
					<button type="button" onClick={() => setView("runtime")}>
						● Runtime ·{" "}
						{checks === undefined ? "Not checked" : `${checks}/3 checks passed`}{" "}
						›
					</button>
				</div>
			</aside>
			<main>
				{error && (
					<div role="alert" className="error">
						{error}
					</div>
				)}
				{renderProjectEditor()}
				{renderRuntime()}
				{renderConversation()}
				{renderScheduleEditor()}
				{renderScheduled()}
			</main>
			{renderContextMenu()}
			{renderSessionDialog()}
		</div>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

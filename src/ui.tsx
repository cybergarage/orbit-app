import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot } from "./types";
import "./ui.css";
function App() {
	const [state, setState] = useState<Snapshot>({ projects: [], schedules: [] });
	const [projectId, setProject] = useState("");
	const [sessionId, setSession] = useState("");
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("gemma4:12b");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [artifacts, setArtifacts] = useState<string[]>([]);
	const [when, setWhen] = useState("");
	const [repeat, setRepeat] = useState("0");
	useEffect(() => {
		void window.orbit.call("snapshot").then(setState);
		return window.orbit.subscribe(setState);
	}, []);
	const project =
		state.projects.find((p) => p.id === projectId) ?? state.projects[0];
	const session =
		project?.sessions.find((s) => s.id === sessionId) ?? project?.sessions[0];
	const active = !!state.active;
	const approval =
		active && state.active?.sessionId === session?.id
			? session?.events.filter((e) => e.type === "approval").at(-1)?.data
			: undefined;
	const pending = approval && session?.status === "awaiting-approval";
	async function action(fn: () => Promise<unknown>) {
		setError("");
		try {
			return await fn();
		} catch (e) {
			setError(String(e));
		}
	}
	async function submit() {
		if (!project || !session || busy || active) return;
		setBusy(true);
		await action(() =>
			window.orbit.call("submit", {
				projectId: project.id,
				sessionId: session.id,
				prompt,
				model,
				requestId: crypto.randomUUID(),
			}),
		);
		setBusy(false);
	}
	return (
		<div className="app">
			<aside>
				<div className="brand">
					<span className="orb">◎</span>
					<div>
						<strong>Orbit</strong>
						<small>LOCAL WORKSPACE</small>
					</div>
				</div>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void action(async () => {
							const p = await window.orbit.call("create-project", { name });
							setProject(p.id);
							setName("");
							const s = await window.orbit.call("create-session", {
								projectId: p.id,
							});
							setSession(s.id);
						});
					}}
				>
					<label htmlFor="project-name">New project</label>
					<div className="inline">
						<input
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Project name"
							maxLength={80}
						/>
						<button disabled={!name.trim()}>+</button>
					</div>
				</form>
				<nav>
					{state.projects.map((p) => (
						<button
							className={p.id === project?.id ? "selected" : ""}
							key={p.id}
							onClick={() => {
								setProject(p.id);
								setSession("");
								setArtifacts([]);
							}}
						>
							<span>◇</span>
							{p.name}
							<small>{p.sessions.length} sessions</small>
						</button>
					))}
				</nav>
				<div className="sidebar-bottom">
					<span className="dot" /> On this Mac only
					<p>
						Workers have no network access.
						<br />
						Ollama stays on the host.
					</p>
				</div>
			</aside>
			<main>
				<header>
					<div>
						<div className="eyebrow">
							PROJECT / {project?.name ?? "GET STARTED"}
						</div>
						<h1>{session?.name ?? "Your local agent workspace"}</h1>
					</div>
					<button
						onClick={() => void action(() => window.orbit.call("health"))}
					>
						↻ Check connections
					</button>
				</header>
				<section className="health">
					<span className={state.health?.ollama ? "ok" : "offline"}>
						● Ollama {state.health?.ollama ? "online" : "offline"}
					</span>
					<span className={state.health?.docker ? "ok" : "offline"}>
						● Docker {state.health?.docker ? "online" : "offline"}
					</span>
					<span className={state.health?.image ? "ok" : "offline"}>
						● Worker {state.health?.image ? "ready" : "image missing"}
					</span>
					<label>
						Model{" "}
						<select
							aria-label="Model"
							value={model}
							onChange={(e) => setModel(e.target.value)}
						>
							{[...new Set([model, ...(state.health?.models ?? [])])].map(
								(m) => (
									<option key={m}>{m}</option>
								),
							)}
						</select>
					</label>
				</section>
				{error && (
					<div role="alert" className="error">
						{error}
					</div>
				)}
				<div className="workspace">
					<section className="conversation">
						<div className="tabs">
							{project?.sessions.map((s) => (
								<button
									className={s.id === session?.id ? "selected" : ""}
									key={s.id}
									onClick={() => setSession(s.id)}
								>
									{s.name}
								</button>
							))}
							<button
								disabled={!project}
								onClick={() =>
									void action(async () => {
										const s = await window.orbit.call("create-session", {
											projectId: project?.id,
										});
										setSession(s.id);
									})
								}
							>
								+ Session
							</button>
							<span className="status">{session?.status ?? "Ready"}</span>
						</div>
						<div className="timeline">
							{!session?.events.length && (
								<div className="welcome">
									<div className="large-orb">◎</div>
									<h2>Work locally. Keep your context.</h2>
									<p>
										Create a project, describe a task, and review each write or
										command before it runs in the container.
									</p>
									<div className="chips">
										<span>Native Ollama</span>
										<span>Isolated worker</span>
										<span>Saved history</span>
									</div>
								</div>
							)}
							{session?.events
								.filter((e) =>
									[
										"submission",
										"agent-event",
										"result",
										"error",
										"interrupted",
										"schedule-error",
									].includes(e.type),
								)
								.map((e) => (
									<article
										key={e.id ?? `${e.at}-${e.type}`}
										className={e.type === "submission" ? "user" : "agent"}
									>
										<small>
											{e.type === "submission"
												? "YOU"
												: e.type === "agent-event"
													? e.data.type
													: "ORBIT"}{" "}
											· {new Date(e.at).toLocaleTimeString()}
										</small>
										<pre>
											{e.type === "submission"
												? e.data.prompt
												: e.type === "result"
													? e.data.answer
													: e.type === "agent-event"
														? (e.data.message?.content ??
															(e.data.toolCall
																? JSON.stringify(e.data.toolCall, null, 2)
																: `Model round ${e.data.iteration ?? ""}`))
														: String(e.data)}
										</pre>
									</article>
								))}
						</div>
						{pending && (
							<div className="approval">
								<strong>Review operation</strong>
								<pre>{JSON.stringify(approval.preview, null, 2)}</pre>
								<button
									onClick={() =>
										void action(() =>
											window.orbit.call("approve", {
												id: approval.id,
												approve: true,
											}),
										)
									}
								>
									Approve
								</button>
								<button
									onClick={() =>
										void action(() =>
											window.orbit.call("approve", {
												id: approval.id,
												approve: false,
											}),
										)
									}
								>
									Deny
								</button>
							</div>
						)}
						<div className="composer">
							<textarea
								aria-label="Task"
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								placeholder="Describe a task for this project's workspace…"
								maxLength={12000}
							/>
							<div>
								<small>
									8 tool rounds · 3.5 minute budget · approvals required
								</small>
								{active ? (
									<button
										className="stop"
										onClick={() =>
											void action(() => window.orbit.call("cancel"))
										}
									>
										Stop worker
									</button>
								) : (
									<button
										className="primary"
										disabled={!session || !prompt.trim() || busy}
										onClick={() => void submit()}
									>
										{busy ? "Starting…" : "Run task ↗"}
									</button>
								)}
							</div>
						</div>
					</section>
					<section className="details">
						<h3>Workspace artifacts</h3>
						<p>Files remain in this project's workspace between sessions.</p>
						<button
							disabled={!project}
							onClick={() =>
								void action(async () =>
									setArtifacts(
										await window.orbit.call("artifacts", {
											projectId: project?.id,
										}),
									),
								)
							}
						>
							Refresh files
						</button>
						{artifacts.map((f) => (
							<div className="file" key={f}>
								▤ {f}
							</div>
						))}
						<hr />
						<h3>Schedule a task</h3>
						<p>
							Runs while this app is open. After a shutdown, one missed
							occurrence is considered. Tool approval still required.
						</p>
						<label htmlFor="when">Local date and time</label>
						<input
							id="when"
							type="datetime-local"
							value={when}
							onChange={(e) => setWhen(e.target.value)}
						/>
						<select
							aria-label="Schedule recurrence"
							value={repeat}
							onChange={(e) => setRepeat(e.target.value)}
						>
							<option value="0">One time</option>
							<option value="3600000">Every hour</option>
							<option value="86400000">Every 24 hours</option>
						</select>
						<button
							disabled={!session || !when || !prompt.trim()}
							onClick={() =>
								void action(() =>
									window.orbit.call("schedule", {
										projectId: project?.id,
										sessionId: session?.id,
										prompt,
										model,
										nextAt: new Date(when).getTime(),
										intervalMs: Number(repeat),
									}),
								)
							}
						>
							Schedule current task
						</button>
						{state.schedules
							.filter((s) => s.projectId === project?.id)
							.map((s) => (
								<div className="scheduled" key={s.id}>
									<small>{new Date(s.nextAt).toLocaleString()}</small>
									<p>{s.prompt.slice(0, 80)}</p>
									<button
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
							))}
					</section>
				</div>
				<footer>
					Orbit core 0.8.1 · Local prototype · Workspaces persist; running tasks
					stop when the app exits
				</footer>
			</main>
		</div>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

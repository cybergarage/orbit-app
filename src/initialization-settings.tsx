import { useEffect, useState } from "react";
import {
	initializationScopes,
	type InitializationMode,
	type InitializationPreview,
} from "./initialization";

export function InitializationSettings() {
	const [root, setRoot] = useState<string>();
	const [error, setError] = useState("");
	const [mode, setMode] = useState<InitializationMode>();
	const [plan, setPlan] = useState<InitializationPreview>();
	const [includeSettings, setIncludeSettings] = useState(false);
	const [stopped, setStopped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [complete, setComplete] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [offline, setOffline] = useState(false);
	useEffect(() => {
		void window.orbit
			.call("initialization-status")
			.then((s) => {
				setRoot(s.root);
				setPlan(s.plan);
				setMode(s.plan?.mode);
				if (s.plan) setIncludeSettings(s.plan.mode !== "data");
				setStopped(s.maintenance);
				setComplete(s.complete);
				setError(s.error ?? "");
			})
			.catch((e) => setError(String(e)));
	}, []);
	async function review(selected: InitializationMode, stop: boolean) {
		setBusy(true);
		setStopping(stop);
		setError("");
		setPlan(undefined);
		setConfirmation("");
		setOffline(false);
		setMode(selected);
		try {
			if (stop) setStopped(true);
			setPlan(
				await window.orbit.call(
					stop ? "initialization-stop" : "initialization-preview",
					{ mode: selected, includeSettings },
				),
			);
		} catch (e) {
			setError(String(e));
		} finally {
			setStopping(false);
			setBusy(false);
		}
	}
	async function initialize() {
		if (!plan?.final || confirmation !== "INITIALIZE" || !offline) return;
		setBusy(true);
		setError("");
		try {
			await window.orbit.call("initialization-execute", {
				planId: plan.id,
				confirmation,
				allWritersStopped: offline,
				automaticRestartersDisabled: offline,
				exclusiveStorageControl: offline,
			});
			setComplete(true);
			setPlan(undefined);
		} catch (e) {
			setError(String(e));
			setPlan(undefined);
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="page" aria-label="Initialization">
			<h1>Initialization</h1>
			<p>
				Orbit App storage is separate from Orbit CLI and the embedded GUI.
				Initialization permanently deletes the reviewed targets. There is no
				Trash, backup or rollback.
			</p>
			{root && (
				<p>
					App storage: <code>{root}</code>
				</p>
			)}
			{error && <p role="alert">{error}</p>}
			{complete ? (
				<>
					<p role="status">
						Initialization completed. Restart before using the App.
					</p>
					<button
						type="button"
						onClick={() => {
							void window.orbit
								.call("initialization-restart")
								.catch((e) => setError(String(e)));
						}}
					>
						Restart App
					</button>
				</>
			) : (
				<>
					<p role="status">
						{stopping
							? "Stopping App writers and verifying final targets…"
							: stopped
								? "App writers remain stopped. Review remaining targets or close the App; incomplete initialization stays in maintenance after restart."
								: "Review targets first. A final plan is created after verified writer shutdown."}
					</p>
					<label>
						<input
							type="checkbox"
							checked={includeSettings}
							disabled={busy}
							onChange={(e) => {
								setIncludeSettings(e.target.checked);
								setPlan(undefined);
								setConfirmation("");
								setOffline(false);
							}}
						/>{" "}
						Explicitly include App settings (appearance only)
					</label>
					{initializationScopes.map((scope) => (
						<div className="card" key={scope.mode}>
							<h2>{scope.title}</h2>
							<p>{scope.description}</p>
							<button
								type="button"
								disabled={busy || (scope.mode !== "data" && !includeSettings)}
								aria-label={`Review ${scope.title.toLowerCase()}`}
								onClick={() => {
									void review(scope.mode, stopped);
								}}
							>
								Review targets
							</button>
						</div>
					))}
					{mode && !complete && !plan?.final && (
						<button
							type="button"
							disabled={busy || (mode !== "data" && !includeSettings)}
							onClick={() => {
								void review(mode, true);
							}}
						>
							Stop App writers and review final targets
						</button>
					)}
					{plan && (
						<section className="card" aria-label="Initialization preview">
							<h2>
								{plan.final
									? "Final initialization targets"
									: "Preview targets"}
							</h2>
							<p>
								Plan: <code>{plan.id}</code>
							</p>
							<table>
								<thead>
									<tr>
										<th>Target</th>
										<th>Scope</th>
										<th>Files</th>
										<th>Bytes</th>
									</tr>
								</thead>
								<tbody>
									{plan.targets.map((t) => (
										<tr key={t.path}>
											<td>
												<code>{t.path}</code>
											</td>
											<td>{t.kind}</td>
											<td>{t.files}</td>
											<td>{t.bytes}</td>
										</tr>
									))}
								</tbody>
							</table>
							<h3>Retained</h3>
							<ul>
								{[...new Set(plan.retained)].map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
							{plan.final && (
								<>
									<label>
										<input
											type="checkbox"
											checked={offline}
											disabled={busy}
											onChange={(e) => setOffline(e.target.checked)}
										/>{" "}
										I have stopped all external writers, disabled automatic
										restarters, and have exclusive control of this App storage.
									</label>
									<label>
										Type INITIALIZE to permanently delete these targets
										<input
											aria-label="Permanent confirmation"
											value={confirmation}
											disabled={busy}
											onChange={(e) => setConfirmation(e.target.value)}
											autoComplete="off"
										/>
									</label>
									<button
										type="button"
										disabled={busy || !offline || confirmation !== "INITIALIZE"}
										onClick={() => {
											void initialize();
										}}
									>
										Permanently initialize
									</button>
								</>
							)}
						</section>
					)}
				</>
			)}
			<p>
				Working files, external workspaces, shared skills, AGENTS.md, ORBIT.md,
				environment credentials, Docker and Ollama are retained. Unknown objects
				and browser profile data are retained. Resetting settings does not
				revoke credentials or alter environment variables.
			</p>
		</section>
	);
}

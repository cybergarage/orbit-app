import { useEffect, useState } from "react";
import { initializationAvailability } from "./initialization";

export function InitializationSettings() {
	const [root, setRoot] = useState<string>();
	const [error, setError] = useState("");
	useEffect(() => {
		void window.orbit
			.call("initialization-status")
			.then((status) => setRoot(status.root))
			.catch((e) => setError(String(e)));
	}, []);
	return (
		<section className="page" aria-label="Initialization">
			<h1>Initialization</h1>
			<p>
				Orbit App has its own storage, separate from Orbit CLI and the embedded
				GUI.
			</p>
			{root && (
				<p>
					App storage: <code>{root}</code>
				</p>
			)}
			{error && <p role="alert">{error}</p>}
			<p role="status">{initializationAvailability.reason}</p>
			{[
				[
					"Reset settings",
					"Restore app preferences without removing Chats or schedules. Settings containing connection or credential information need explicit selection.",
				],
				[
					"Reset conversations, projects and schedules",
					"Remove app registrations, conversations, execution history and schedules as one consistent set. Keep settings and working files.",
				],
				[
					"Reset all app settings, saved data and owned cache",
					"Combine settings and saved-data initialization with app-owned cache. Keep user working files and external workspaces.",
				],
			].map(([title, description]) => (
				<div className="card" key={title}>
					<h2>{title}</h2>
					<p>{description}</p>
					<button
						type="button"
						disabled
						aria-label={`Review ${title.toLowerCase()}`}
					>
						Review targets (requires Electron adapter)
					</button>
				</div>
			))}
			<p>
				Pending Electron integration: target paths and counts, explicit
				confirmation, and verified shutdown before changes. Permanent deletion
				and OS Trash must be clearly distinguished. No reset or backup is
				performed by this screen.
			</p>
			<p>
				Working files, external workspaces, shared skills, AGENTS.md, ORBIT.md,
				environment credentials, Docker and Ollama are excluded by default.
			</p>
		</section>
	);
}

import { useRef, useState } from "react";
import type {
	ProjectMemoryEntry,
	ProjectAutomation,
	ProjectExtractionJob,
} from "@cybergarage/orbit";
export function KnowledgePanel({
	projectId,
	sessionId,
	projectArchived,
	sessionArchived,
	onSource,
}: {
	projectId: string;
	sessionId: string;
	projectArchived?: boolean;
	sessionArchived?: boolean;
	onSource: (sessionId: string) => void;
}) {
	const [status, setStatus] = useState<{
		entries: ProjectMemoryEntry[];
		config: ProjectAutomation | null;
		jobs: ProjectExtractionJob[];
		blocked?: string;
	}>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	const [editing, setEditing] = useState<string>();
	const [body, setBody] = useState("");
	const [outputLimit, setOutputLimit] = useState(16384);
	const [callLimit, setCallLimit] = useState(16);
	const [limit, setLimit] = useState(100000);
	const initializedProject = useRef<string | undefined>(undefined);
	const load = async () => {
		const loaded = await window.orbit.call("knowledge-status", { projectId });
		setStatus(loaded);
		if (initializedProject.current !== projectId) {
			setLimit(loaded.config?.maxInputTokens ?? 100000);
			setOutputLimit(loaded.config?.maxOutputTokens ?? 16384);
			setCallLimit(loaded.config?.maxCalls ?? 16);
			initializedProject.current = projectId;
		}
	};
	const action = async (work: () => Promise<unknown>, refresh = true) => {
		if (pending.current) return;
		pending.current = true;
		setBusy(true);
		try {
			setError("");
			await work();
			if (refresh) await load();
		} catch (error) {
			setError(String(error));
		} finally {
			pending.current = false;
			setBusy(false);
		}
	};

	return (
		<details
			className="knowledge-panel"
			onToggle={(event) => {
				if (event.currentTarget.open) void action(load, false);
			}}
		>
			<summary>Project knowledge</summary>
			<fieldset disabled={busy}>
				<button
					type="button"
					onClick={() =>
						void action(() =>
							window.orbit.call("archive-project", {
								projectId,
								archived: !projectArchived,
							}),
						)
					}
				>
					{projectArchived ? "Restore Project" : "Archive Project"}
				</button>
				<button
					type="button"
					onClick={() =>
						void action(() =>
							window.orbit.call("archive-session", {
								projectId,
								sessionId,
								archived: !sessionArchived,
							}),
						)
					}
				>
					{sessionArchived ? "Restore conversation" : "Archive conversation"}
				</button>
				<p>
					Knowledge is learned automatically after completed conversations and
					reused by relevance. Historical context never grants permission.
				</p>
				{error && <p role="alert">{error}</p>}
				<button type="button" onClick={() => void action(load, false)}>
					Refresh knowledge
				</button>
				<button
					type="button"
					onClick={() =>
						void action(() =>
							window.orbit.call("knowledge-control", {
								projectId,
								enabled: status?.config?.enabled === false,
							}),
						)
					}
				>
					{status?.config?.enabled === false
						? "Resume learning"
						: "Stop learning"}
				</button>
				<p role="status">
					{status?.blocked ??
						`${status?.jobs.filter((job) => ["pending", "running"].includes(job.state)).length ?? 0} jobs pending; ${status?.config?.calls ?? 0} calls reserved`}
				</p>
				<p>
					Reserved tokens: {status?.config?.inputTokens ?? 0} input /{" "}
					{status?.config?.outputTokens ?? 0} output. Reported usage:{" "}
					{status?.config?.observedInputTokens ?? 0} input /{" "}
					{status?.config?.observedOutputTokens ?? 0} output. Missing usage does
					not refund reservations.
				</p>
				<label>
					Lifetime input-token limit{" "}
					<input
						type="number"
						min="4096"
						max="10000000"
						value={limit}
						onChange={(event) => setLimit(Number(event.target.value))}
					/>
				</label>
				<label>
					Lifetime output-token limit{" "}
					<input
						type="number"
						min="0"
						max="1000000"
						value={outputLimit}
						onChange={(event) => setOutputLimit(Number(event.target.value))}
					/>
				</label>
				<label>
					Lifetime call limit{" "}
					<input
						type="number"
						min="0"
						max="10000"
						value={callLimit}
						onChange={(event) => setCallLimit(Number(event.target.value))}
					/>
				</label>
				<button
					type="button"
					onClick={() =>
						void action(() =>
							window.orbit.call("knowledge-control", {
								projectId,
								enabled: status?.config?.enabled !== false,
								limits: {
									maxInputTokens: limit,
									maxOutputTokens: outputLimit,
									maxCalls: callLimit,
								},
							}),
						)
					}
				>
					Apply token limit
				</button>
				<p>
					Extraction uses the local installed gemma4:12b model, without tools.
					Limits cap attempts and tokens; no hosted-model price is inferred.
				</p>
				{status?.entries.map((entry) => (
					<article key={entry.id}>
						<strong>
							{entry.title} · revision {entry.revision}
							{entry.retired
								? " · deleted"
								: entry.automatic?.pending
									? " · pending"
									: ""}
						</strong>
						<p>{entry.body}</p>
						<small>{entry.automatic?.condition}</small>
						{entry.sources.map((source) => (
							<button
								type="button"
								key={`${source.sessionId}/${source.messageId}`}
								onClick={() => onSource(source.sessionId)}
							>
								Source {source.sessionId.slice(0, 8)} /{" "}
								{source.messageId.slice(0, 8)}
							</button>
						))}
						<button
							type="button"
							onClick={() => {
								setEditing(entry.id);
								setBody(entry.body);
							}}
						>
							Edit or correct
						</button>
						<button
							type="button"
							disabled={entry.retired}
							onClick={() =>
								void action(() =>
									window.orbit.call("knowledge-edit", {
										projectId,
										id: entry.id,
										expectedRevision: entry.revision,
										body: entry.body,
										retired: true,
									}),
								)
							}
						>
							Delete knowledge
						</button>
						{editing === entry.id && (
							<div>
								<textarea
									aria-label="Knowledge correction"
									value={body}
									onChange={(event) => setBody(event.target.value)}
								/>
								<button
									type="button"
									onClick={() =>
										void action(async () => {
											await window.orbit.call("knowledge-edit", {
												projectId,
												id: entry.id,
												expectedRevision: entry.revision,
												body,
												retired: entry.retired,
											});
											setEditing(undefined);
										})
									}
								>
									Save correction
								</button>
							</div>
						)}
					</article>
				))}
				<details>
					<summary>Processing history</summary>
					<pre>
						{JSON.stringify(
							status?.jobs.map(
								({ id, state, attempt, error, inputTokens, outputTokens }) => ({
									id,
									state,
									attempt,
									error,
									inputTokens,
									outputTokens,
								}),
							),
							null,
							2,
						)}
					</pre>
				</details>
			</fieldset>
		</details>
	);
}

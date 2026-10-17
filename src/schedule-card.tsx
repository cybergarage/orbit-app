import { useEffect, useRef, useState } from "react";
import type { Schedule } from "./types";
import { describeRepeat, scheduledTime } from "./scheduling";

export function ScheduleCard({
	schedule,
	projectName,
	running,
	onEdit,
}: {
	readonly schedule: Schedule;
	readonly projectName?: string;
	readonly running: boolean;
	readonly onEdit: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [deleting, setDeleting] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (deleting) dialog.current?.showModal();
	}, [deleting]);
	async function change(command: string) {
		setBusy(true);
		setError("");
		try {
			await window.orbit.call(command, {
				id: schedule.id,
				...(command === "delete-schedule" ? { confirmation: schedule.id } : {}),
			});
			setDeleting(false);
		} catch (e) {
			setError(String(e).replace(/^Error: /, ""));
		} finally {
			setBusy(false);
		}
	}
	return (
		<article
			className="card"
			aria-label={`Scheduled task: ${schedule.prompt}`}
			aria-busy={busy}
		>
			<strong>{schedule.prompt}</strong>
			<p>
				{projectName} · {schedule.model}
			</p>
			{schedule.plan && (
				<p>
					First: {scheduledTime(schedule.plan.firstAt, schedule.plan.timeZone)}{" "}
					· {schedule.plan.timeZone}
				</p>
			)}
			<p>
				{schedule.enabled
					? `Next: ${schedule.plan ? `${scheduledTime(schedule.nextAt, schedule.plan.timeZone)} · ${schedule.plan.timeZone}` : new Date(schedule.nextAt).toLocaleString()}`
					: "Disabled"}{" "}
				·{" "}
				{schedule.plan
					? describeRepeat(schedule.plan.repeat)
					: schedule.intervalMs
						? `Every ${schedule.intervalMs / 3600000} hours`
						: "One time"}
			</p>
			{running && (
				<p>
					An admitted run is in progress. Disabling or deleting this task lets
					that run finish.
				</p>
			)}
			<p>
				<small>
					Enable skips elapsed slots. Past one-time tasks need a new future
					time. Chats, files and execution history are retained.
				</small>
			</p>
			{error && !deleting && <p role="alert">{error}</p>}
			<div className="actions">
				<button type="button" disabled={busy} onClick={onEdit}>
					Edit schedule
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						void change(
							schedule.enabled ? "disable-schedule" : "enable-schedule",
						)
					}
				>
					{schedule.enabled ? "Disable" : "Enable"}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						setError("");
						setDeleting(true);
					}}
				>
					Delete task
				</button>
			</div>
			{deleting && (
				<dialog
					ref={dialog}
					className="modal"
					aria-label="Delete scheduled task"
					onCancel={(event) => {
						event.preventDefault();
						if (!busy) setDeleting(false);
					}}
				>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void change("delete-schedule");
						}}
					>
						<h2>Delete scheduled task?</h2>
						<p>{schedule.prompt}</p>
						<p>
							This removes only this task and prevents future runs. Already
							admitted runs continue. Chats, working files and execution history
							remain.
						</p>
						{error && <p role="alert">{error}</p>}
						<div className="actions">
							<button
								type="button"
								disabled={busy}
								onClick={() => setDeleting(false)}
							>
								Cancel
							</button>
							<button type="submit" disabled={busy}>
								{busy ? "Deleting…" : "Delete scheduled task"}
							</button>
						</div>
					</form>
				</dialog>
			)}
		</article>
	);
}

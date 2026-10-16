import { useState, useEffect } from "react";
import type { Schedule } from "./types";
import {
	resolveSchedule,
	nextOccurrence,
	localDateTime,
	scheduledTime,
	describeRepeat,
	type ScheduleInput,
	type RepeatRule,
} from "./scheduling";
export function ScheduleEditor({
	existing,
	prompt: initialPrompt,
	model: initialModel,
	models,
	onSave,
	onCancel,
}: {
	existing?: Schedule;
	prompt: string;
	model: string;
	models: string[];
	onSave: (value: {
		prompt: string;
		model: string;
		timing?: ScheduleInput;
		operationId?: string;
	}) => Promise<void>;
	onCancel: () => void;
}) {
	const [operationId] = useState(() => crypto.randomUUID());
	const zone =
		existing?.plan?.timeZone ??
		Intl.DateTimeFormat().resolvedOptions().timeZone;
	const oldRepeat =
		existing?.plan?.repeat ??
		(existing?.intervalMs
			? ({ kind: "interval", minutes: existing.intervalMs / 60000 } as const)
			: ({ kind: "none" } as const));
	const repeatValue =
		oldRepeat.kind === "none"
			? "none"
			: oldRepeat.kind === "calendar"
				? oldRepeat.every !== 1
					? "custom"
					: oldRepeat.unit === "day"
						? "daily"
						: "weekly"
				: [15, 30, 60].includes(oldRepeat.minutes)
					? String(oldRepeat.minutes)
					: "custom";
	const [prompt, setPrompt] = useState(existing?.prompt ?? initialPrompt),
		[model, setModel] = useState(existing?.model ?? initialModel);
	const [first, setFirst] = useState(existing ? "absolute" : "900000"),
		[local, setLocal] = useState(
			existing ? localDateTime(existing.nextAt, zone) : "",
		);
	const [repeat, setRepeat] = useState(repeatValue),
		[timeZone, setZone] = useState(zone),
		[every, setEvery] = useState(
			oldRepeat.kind === "interval"
				? oldRepeat.minutes
				: oldRepeat.kind === "calendar"
					? oldRepeat.every
					: 1,
		),
		[unit, setUnit] = useState(
			oldRepeat.kind === "calendar" ? oldRepeat.unit : "minutes",
		);
	const [error, setError] = useState(""),
		[saving, setSaving] = useState(false),
		[now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	function timing(): ScheduleInput {
		let rule: RepeatRule = { kind: "none" };
		if (["15", "30", "60"].includes(repeat))
			rule = { kind: "interval", minutes: Number(repeat) };
		if (repeat === "daily" || repeat === "weekly")
			rule = {
				kind: "calendar",
				unit: repeat === "daily" ? "day" : "week",
				every: 1,
			};
		if (repeat === "custom")
			rule =
				unit === "day" || unit === "week"
					? { kind: "calendar", unit, every: Number(every) }
					: {
							kind: "interval",
							minutes: Number(every) * (unit === "hours" ? 60 : 1),
						};
		return {
			first:
				first === "absolute"
					? { kind: "absolute", local }
					: { kind: "relative", delayMs: Number(first) },
			timeZone,
			repeat: rule,
		};
	}
	const initialTiming = JSON.stringify({
		first: {
			kind: "absolute",
			local: existing ? localDateTime(existing.nextAt, zone) : "",
		},
		timeZone: zone,
		repeat: oldRepeat,
	});
	const changed = !existing || JSON.stringify(timing()) !== initialTiming;
	let preview = "",
		problem = "";
	try {
		const plan = changed ? resolveSchedule(timing(), now) : existing?.plan;
		const at = changed ? plan?.firstAt : existing?.nextAt;
		if (at === undefined) throw Error("Choose a first run.");
		const next = plan
			? nextOccurrence(plan, at)
			: existing?.intervalMs
				? at + existing?.intervalMs
				: undefined;
		preview = `${existing ? "Next run" : first === "absolute" ? "First run" : "If created now"}: ${scheduledTime(at, timeZone)} · ${timeZone}${next ? `\nThen: ${scheduledTime(next, timeZone)} · ${describeRepeat(plan?.repeat ?? oldRepeat)}` : "\nOne run"}`;
	} catch (e) {
		problem = String(e).replace(/^Error: /, "");
	}
	const calendar = repeat === "daily" || repeat === "weekly";
	return (
		<section className="page schedule-page">
			<h1>{existing ? "Edit scheduled task" : "New scheduled task"}</h1>
			<div className="notice">
				<strong>Runs while Orbit App is open</strong>
				<p>
					Requested writes and commands still need approval. Missed runs
					coalesce into one; interrupted runs are not replayed.
				</p>
			</div>
			<form
				className="schedule-form"
				onSubmit={async (e) => {
					e.preventDefault();
					setError("");
					if (problem) {
						setError(problem);
						return;
					}
					setSaving(true);
					try {
						await onSave({
							operationId,
							prompt,
							model,
							timing: changed ? timing() : undefined,
						});
					} catch (e) {
						setError(String(e).replace(/^Error: /, ""));
					} finally {
						setSaving(false);
					}
				}}
			>
				<label htmlFor="scheduled-task">Task</label>
				<textarea
					id="scheduled-task"
					aria-label="Task input"
					value={prompt}
					maxLength={12000}
					required
					onChange={(e) => setPrompt(e.target.value)}
				/>
				<label className="select-row">
					Repeat
					<select
						aria-label="Schedule recurrence"
						value={repeat}
						onChange={(e) => {
							setError("");
							const value = e.target.value;
							setRepeat(value);
							if (["daily", "weekly"].includes(value) && first !== "absolute") {
								setFirst("absolute");
								setLocal(
									localDateTime(now + 86400000, timeZone).slice(0, 11) +
										"09:00",
								);
							}
						}}
					>
						<option value="none">Does not repeat</option>
						<option value="15">Every 15 minutes</option>
						<option value="30">Every 30 minutes</option>
						<option value="60">Every hour</option>
						<option value="daily">Daily</option>
						<option value="weekly">Weekly</option>
						<option value="custom">Custom…</option>
					</select>
				</label>
				{repeat === "custom" && (
					<div className="actions">
						<label>
							Every
							<input
								aria-label="Repeat count"
								type="number"
								min="1"
								max={
									unit === "minutes" ? 525600 : unit === "hours" ? 8760 : 365
								}
								value={every}
								onChange={(e) => setEvery(Number(e.target.value))}
							/>
						</label>
						<label>
							Unit
							<select
								aria-label="Repeat unit"
								value={unit}
								onChange={(e) => setUnit(e.target.value)}
							>
								<option value="minutes">Minutes</option>
								<option value="hours">Hours</option>
								<option value="day">Days (local time)</option>
								<option value="week">Weeks (local time)</option>
							</select>
						</label>
					</div>
				)}
				<label className="select-row">
					{existing ? "Next run" : "First run"}
					<select
						aria-label="First run"
						value={first}
						onChange={(e) => {
							setError("");
							setFirst(e.target.value);
						}}
					>
						<option value="900000">
							{existing
								? "15 minutes after saving"
								: "15 minutes after creation"}
						</option>
						<option value="3600000">
							{existing ? "1 hour after saving" : "1 hour after creation"}
						</option>
						<option value="absolute">Choose date and time…</option>
					</select>
				</label>
				{first === "absolute" &&
					(calendar ? (
						<div className="actions">
							<label>
								Time
								<input
									aria-label="Calendar time"
									type="time"
									required
									value={local.slice(11, 16)}
									onChange={(e) =>
										setLocal(`${local.slice(0, 10)}T${e.target.value}`)
									}
								/>
							</label>
							<label>
								Starts
								<input
									aria-label="Calendar start date"
									type="date"
									required
									value={local.slice(0, 10)}
									onChange={(e) =>
										setLocal(
											`${e.target.value}T${local.slice(11, 16) || "09:00"}`,
										)
									}
								/>
							</label>
						</div>
					) : (
						<label>
							Local date and time
							<input
								aria-label="Local date and time"
								type="datetime-local"
								value={local}
								required
								onChange={(e) => {
									setError("");
									setLocal(e.target.value);
								}}
							/>
						</label>
					))}
				<label>
					Time zone
					<input
						aria-label="Time zone"
						value={timeZone}
						required
						onChange={(e) => {
							setError("");
							setZone(e.target.value);
						}}
					/>
				</label>
				<p>
					{first !== "absolute"
						? "The timer starts when creation is committed, not while editing."
						: "Intervals keep the first scheduled run as their anchor."}{" "}
					Daily/weekly use the saved time zone. DST gaps move forward; repeated
					clock times run once at the earlier offset.
				</p>
				{(problem || error) && (
					<div role="alert" className="error">
						{error || problem}
						<button
							type="button"
							onClick={() => {
								setFirst("900000");
								setError("");
							}}
						>
							Use 15 minutes from creation
						</button>
						{first === "absolute" && (
							<button
								type="button"
								onClick={() =>
									document
										.querySelector<HTMLInputElement>(
											'[aria-label="Local date and time"], [aria-label="Calendar time"]',
										)
										?.focus()
								}
							>
								Choose a future time
							</button>
						)}
					</div>
				)}
				{preview && (
					<pre className="notice" aria-live="polite">
						{preview}
					</pre>
				)}
				<label className="select-row">
					Model
					<select
						aria-label="Schedule model"
						value={model}
						onChange={(e) => setModel(e.target.value)}
						required
					>
						<option value="">Select an installed model</option>
						{Array.from(
							new Set([
								...models,
								...(existing?.model ? [existing.model] : []),
							]),
						).map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
				</label>
				<div className="actions">
					<button type="button" onClick={onCancel}>
						Cancel
					</button>
					<button
						className="primary"
						disabled={!prompt.trim() || !model || saving}
					>
						{saving ? "Saving…" : existing ? "Save schedule" : "Schedule task"}
					</button>
				</div>
			</form>
		</section>
	);
}

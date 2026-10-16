import { Temporal } from "@js-temporal/polyfill";
export type RepeatRule =
	| { kind: "none" }
	| { kind: "interval"; minutes: number }
	| { kind: "calendar"; unit: "day" | "week"; every: number };
export interface ScheduleInput {
	first:
		| { kind: "relative"; delayMs: number }
		| { kind: "absolute"; local: string };
	timeZone: string;
	repeat: RepeatRule;
}
export interface SchedulePlan {
	firstAt: number;
	timeZone: string;
	repeat: RepeatRule;
	wallTime: string;
}
export function localDateTime(at: number, zone: string) {
	return Temporal.Instant.fromEpochMilliseconds(at)
		.toZonedDateTimeISO(zone)
		.toPlainDateTime()
		.toString({ smallestUnit: "minute" });
}
export function resolveSchedule(
	input: ScheduleInput,
	now: number,
): SchedulePlan {
	if (!input?.first || !input.repeat)
		throw Error("Choose a first run and repeat rule.");
	try {
		if (typeof input.timeZone !== "string" || /^[+-]/.test(input.timeZone))
			throw Error("A named time zone is required");
		Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
			input.timeZone,
		);
	} catch {
		throw Error("Enter a valid IANA time zone, for example Asia/Tokyo.");
	}
	const repeat = input.repeat;
	if (
		repeat.kind === "interval" &&
		(!Number.isSafeInteger(repeat.minutes) ||
			repeat.minutes < 1 ||
			repeat.minutes > 525600)
	)
		throw Error("Repeat interval must be between 1 and 525600 minutes.");
	if (
		repeat.kind === "calendar" &&
		(!["day", "week"].includes(repeat.unit) ||
			!Number.isSafeInteger(repeat.every) ||
			repeat.every < 1 ||
			repeat.every > 365)
	)
		throw Error("Calendar repeat must be between 1 and 365 days or weeks.");
	if (!["none", "interval", "calendar"].includes(repeat.kind))
		throw Error("Choose a supported repeat rule.");
	let firstAt: number;
	if (input.first.kind === "relative") {
		if (![900000, 3600000].includes(input.first.delayMs))
			throw Error("Choose 15 minutes or 1 hour after creation.");
		firstAt = now + input.first.delayMs;
	} else if (input.first.kind === "absolute") {
		try {
			firstAt = Temporal.PlainDateTime.from(input.first.local).toZonedDateTime(
				input.timeZone,
				{ disambiguation: "compatible" },
			).epochMilliseconds;
		} catch {
			throw Error("Choose a valid first-run date and time.");
		}
	} else throw Error("Choose a first run.");
	if (firstAt <= now)
		throw Error(
			"That time has passed. Choose a future time or use 15 minutes from creation.",
		);
	return {
		firstAt,
		timeZone: input.timeZone,
		repeat: structuredClone(repeat),
		wallTime:
			input.first.kind === "absolute"
				? Temporal.PlainDateTime.from(input.first.local).toString()
				: Temporal.Instant.fromEpochMilliseconds(firstAt)
						.toZonedDateTimeISO(input.timeZone)
						.toPlainDateTime()
						.toString(),
	};
}
/** Return the next future slot, coalescing missed slots without changing the anchor. */
export function nextOccurrence(
	plan: SchedulePlan,
	now: number,
): number | undefined {
	const rule = plan.repeat;
	if (rule.kind === "none") return undefined;
	if (rule.kind === "interval") {
		const step = rule.minutes * 60000;
		return (
			plan.firstAt +
			Math.max(1, Math.floor((now - plan.firstAt) / step) + 1) * step
		);
	}
	const base = Temporal.PlainDateTime.from(plan.wallTime);
	const date = Temporal.Instant.fromEpochMilliseconds(now)
		.toZonedDateTimeISO(plan.timeZone)
		.toPlainDate();
	const days = rule.every * (rule.unit === "week" ? 7 : 1);
	let slot = Math.max(
		1,
		Math.floor(base.toPlainDate().until(date).days / days),
	);
	for (;;) {
		const next = base
			.add({ days: slot * days })
			.toZonedDateTime(plan.timeZone, {
				disambiguation: "compatible",
			}).epochMilliseconds;
		if (next > now) return next;
		slot++;
	}
}
export function describeRepeat(rule: RepeatRule) {
	if (rule.kind === "none") return "Does not repeat";
	if (rule.kind === "interval") return `Every ${rule.minutes} minutes`;
	return `Every ${rule.every === 1 ? "" : `${rule.every} `}${rule.unit === "day" ? "day" : "week"}`;
}
export function scheduledTime(at: number, zone: string) {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "shortOffset",
		timeZone: zone,
	}).format(at);
}

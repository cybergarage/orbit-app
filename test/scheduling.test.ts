import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveSchedule,
	nextOccurrence,
	resumeOccurrence,
} from "../src/scheduling";
const at = (s: string) => Date.parse(s);
test("relative first run resolves at creation, absolute past reports a corrective error", () => {
	const now = at("2026-10-16T00:00:00Z");
	const plan = resolveSchedule(
		{
			first: { kind: "relative", delayMs: 900000 },
			timeZone: "Asia/Tokyo",
			repeat: { kind: "none" },
		},
		now,
	);
	assert.equal(plan.firstAt, now + 900000);
	assert.equal(nextOccurrence(plan, plan.firstAt), undefined);
	const calendar = resolveSchedule(
		{
			first: { kind: "relative", delayMs: 900000 },
			timeZone: "UTC",
			repeat: { kind: "calendar", unit: "day", every: 1 },
		},
		now + 12345,
	);
	assert.equal(
		nextOccurrence(calendar, calendar.firstAt),
		calendar.firstAt + 86400000,
	);

	assert.throws(
		() =>
			resolveSchedule(
				{
					first: { kind: "absolute", local: "2026-10-16T09:00" },
					timeZone: "Asia/Tokyo",
					repeat: { kind: "none" },
				},
				now,
			),
		/time has passed/,
	);
});
test("fixed intervals retain the planned anchor through lateness, long runs and restart", () => {
	const plan = resolveSchedule(
		{
			first: { kind: "absolute", local: "2026-10-16T10:15" },
			timeZone: "UTC",
			repeat: { kind: "interval", minutes: 15 },
		},
		at("2026-10-16T09:00Z"),
	);
	assert.equal(
		nextOccurrence(plan, at("2026-10-16T10:16:08Z")),
		at("2026-10-16T10:30Z"),
	);
	const restored = JSON.parse(JSON.stringify(plan));
	assert.equal(
		nextOccurrence(restored, at("2026-10-19T13:04Z")),
		at("2026-10-19T13:15Z"),
	);
});
test("daily preserves wall time across spring gap and returns to original clock on the next day", () => {
	const plan = resolveSchedule(
		{
			first: { kind: "absolute", local: "2026-03-07T02:30" },
			timeZone: "America/New_York",
			repeat: { kind: "calendar", unit: "day", every: 1 },
		},
		at("2026-03-06T00:00Z"),
	);
	const gap = nextOccurrence(plan, plan.firstAt);
	assert.equal(gap, at("2026-03-08T07:30Z"));
	assert.equal(nextOccurrence(plan, Number(gap)), at("2026-03-09T06:30Z"));
});
test("autumn repeated time selects earlier offset once, weekly is a local calendar rule", () => {
	const plan = resolveSchedule(
		{
			first: { kind: "absolute", local: "2026-10-25T01:30" },
			timeZone: "America/New_York",
			repeat: { kind: "calendar", unit: "week", every: 1 },
		},
		at("2026-10-24T00:00Z"),
	);
	const overlap = nextOccurrence(plan, plan.firstAt);
	assert.equal(overlap, at("2026-11-01T05:30Z"));
	assert.equal(
		nextOccurrence(plan, at("2026-11-01T05:45Z")),
		at("2026-11-08T06:30Z"),
	);
});
test("invalid zones and unbounded intervals are rejected", () => {
	const input = {
		first: { kind: "relative", delayMs: 900000 } as const,
		timeZone: "Invalid/Zone",
		repeat: { kind: "interval", minutes: 15 } as const,
	};
	assert.throws(() => resolveSchedule(input, Date.now()), /IANA/);
	assert.throws(
		() => resolveSchedule({ ...input, timeZone: "+09:00" }, Date.now()),
		/IANA/,
	);

	assert.throws(
		() =>
			resolveSchedule(
				{ ...input, timeZone: "UTC", repeat: { kind: "interval", minutes: 0 } },
				Date.now(),
			),
		/interval/,
	);
});

test("resume keeps future slots and skips elapsed interval/calendar slots without changing anchors", () => {
	const now = at("2026-10-16T10:20Z");
	const plan = resolveSchedule(
		{
			first: { kind: "absolute", local: "2026-10-16T10:00" },
			timeZone: "UTC",
			repeat: { kind: "interval", minutes: 15 },
		},
		at("2026-10-16T09:00Z"),
	);
	assert.equal(
		resumeOccurrence(
			{ nextAt: at("2026-10-16T10:30Z"), intervalMs: 900000, plan },
			now,
		),
		at("2026-10-16T10:30Z"),
	);
	assert.equal(
		resumeOccurrence({ nextAt: plan.firstAt, intervalMs: 900000, plan }, now),
		at("2026-10-16T10:30Z"),
	);
	assert.equal(
		resumeOccurrence({ nextAt: plan.firstAt, intervalMs: 900000 }, now),
		at("2026-10-16T10:30Z"),
	);
	assert.equal(plan.firstAt, at("2026-10-16T10:00Z"));
	const daily = resolveSchedule(
		{
			first: { kind: "absolute", local: "2026-03-07T02:30" },
			timeZone: "America/New_York",
			repeat: { kind: "calendar", unit: "day", every: 1 },
		},
		at("2026-03-06T00:00Z"),
	);
	assert.equal(
		resumeOccurrence(
			{ nextAt: daily.firstAt, intervalMs: 0, plan: daily },
			at("2026-03-08T08:00Z"),
		),
		at("2026-03-09T06:30Z"),
	);
});

test("one-time resume requires a future unconsumed slot and rejects elapsed or invalid time", () => {
	const now = at("2026-10-16T10:20Z");
	assert.equal(
		resumeOccurrence({ nextAt: now + 1, intervalMs: 0 }, now),
		now + 1,
	);
	for (const nextAt of [now, now - 1])
		assert.throws(
			() => resumeOccurrence({ nextAt, intervalMs: 0 }, now),
			/Edit its first-run time/,
		);
	assert.throws(
		() => resumeOccurrence({ nextAt: Number.NaN, intervalMs: 0 }, now),
		/Invalid saved/,
	);
});

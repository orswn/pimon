import { describe, expect, it } from "vite-plus/test";
import {
	bootChanged,
	bootTimeOf,
	bootNeedsSave,
	hostRebooted,
	type ClockMark,
	detectGap,
	formatDuration,
	formatNow,
	formatOffset,
	type Gap,
	type GapInput,
	gapSummary,
	gapText,
} from "./gap.ts";

const MIN = 60_000;
const start: ClockMark = { wall: Date.UTC(2026, 10, 9, 9, 0), mono: 1_000_000_000n, uptime: 1000 };
const later = (ms: number, suspendedMs = 0): ClockMark => ({
	wall: start.wall + ms,
	mono: start.mono + BigInt(ms - suspendedMs) * 1_000_000n,
	uptime: start.uptime + ms / 1000,
});
const input = (now: ClockMark, overrides: Partial<GapInput> = {}): GapInput => ({
	now,
	offsetMinutes: 420,
	lastActivity: start.wall,
	mark: start,
	idleMs: 30 * MIN,
	hostRestarted: false,
	pi: undefined,
	...overrides,
});

describe("detectGap", () => {
	it("needs a full idle threshold", () => {
		expect(detectGap(input(later(30 * MIN - 1000)))).toBeUndefined();
		expect(detectGap(input(later(30 * MIN)))).toMatchObject({ gapMs: 30 * MIN });
	});

	it("has no idle gap without activity in the session", () => {
		expect(detectGap(input(later(90 * MIN), { lastActivity: undefined }))).toBeUndefined();
	});

	it("reports a suspend of 60 s and more", () => {
		expect(detectGap(input(later(5 * MIN, 59_000)))).toBeUndefined();
		expect(detectGap(input(later(5 * MIN, 60_000)))?.host).toEqual({ kind: "suspend", ms: 60_000 });
	});

	it("has no suspend without a mark of this process", () => {
		expect(detectGap(input(later(5 * MIN, 120_000), { mark: undefined }))).toBeUndefined();
	});

	it("marks whether the idle threshold was reached", () => {
		expect(detectGap(input(later(MIN), { pi: "reload" }))?.idle).toBe(false);
		expect(detectGap(input(later(30 * MIN), { pi: "reload" }))?.idle).toBe(true);
	});

	it("reports a reload or restart without an idle gap", () => {
		expect(detectGap(input(later(1000), { pi: "reload" }))).toMatchObject({ gapMs: 1000, pi: "reload" });
		expect(detectGap(input(later(1000), { pi: "restart" }))).toMatchObject({ pi: "restart" });
	});

	it("reports a host restart as a pi restart and not as a suspend", () => {
		const gap = detectGap(input(later(5 * MIN, 120_000), { hostRestarted: true }));
		expect(gap).toMatchObject({ host: { kind: "host-restart" }, pi: "restart" });
	});

	it("uses the mark for the gap when the session has no activity", () => {
		expect(detectGap(input(later(5 * MIN, 120_000), { lastActivity: undefined }))?.gapMs).toBe(5 * MIN);
	});
});

describe("boot time", () => {
	it("subtracts the uptime from the wall time", () => {
		expect(bootTimeOf({ wall: 10_000_400, mono: 0n, uptime: 9000 })).toBe(1000);
	});

	it("changes only by more than 5 s", () => {
		expect(bootChanged(undefined, 1000)).toBe(false);
		expect(bootChanged(1000, 1005)).toBe(false);
		expect(bootChanged(1000, 994)).toBe(true);
		expect(bootChanged(1000, 1006)).toBe(true);
	});

	it("compares the boot id when both stamps have one", () => {
		expect(hostRebooted({ bootTime: 1000, bootId: "a" }, { bootTime: 4600, bootId: "a" })).toBe(false);
		expect(hostRebooted({ bootTime: 1000, bootId: "a" }, { bootTime: 1000, bootId: "b" })).toBe(true);
	});

	it("falls back to the boot time without a boot id on both sides", () => {
		expect(hostRebooted(undefined, { bootTime: 1000, bootId: "a" })).toBe(false);
		expect(hostRebooted({ bootTime: 1000 }, { bootTime: 1005, bootId: "a" })).toBe(false);
		expect(hostRebooted({ bootTime: 1000 }, { bootTime: 1006, bootId: "a" })).toBe(true);
		expect(hostRebooted({ bootTime: 1000, bootId: "a" }, { bootTime: 1006 })).toBe(true);
	});

	it("saves a stamp that is missing, moved, or gains a boot id", () => {
		expect(bootNeedsSave(undefined, { bootTime: 1000 })).toBe(true);
		expect(bootNeedsSave({ bootTime: 1000, bootId: "a" }, { bootTime: 1003, bootId: "a" })).toBe(false);
		expect(bootNeedsSave({ bootTime: 1000 }, { bootTime: 1003 })).toBe(false);
		expect(bootNeedsSave({ bootTime: 1000 }, { bootTime: 1003, bootId: "a" })).toBe(true);
		expect(bootNeedsSave({ bootTime: 1000, bootId: "a" }, { bootTime: 1000, bootId: "b" })).toBe(true);
	});
});

describe("formatting", () => {
	it.each([
		[59_000, "<1m"],
		[MIN, "1m"],
		[45 * MIN, "45m"],
		[60 * MIN, "1h"],
		[134 * MIN, "2h 14m"],
		[(3 * 24 + 4) * 60 * MIN + 59 * MIN, "3d 4h"],
		[48 * 60 * MIN, "2d"],
	])("formats %i ms as %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});

	it.each([
		[420, "+07"],
		[330, "+05:30"],
		[-240, "-04"],
		[0, "+00"],
		[-570, "-09:30"],
	])("formats offset %i as %s", (offset, text) => {
		expect(formatOffset(offset)).toBe(text);
	});

	it("shows local time with the offset", () => {
		expect(formatNow(Date.UTC(2026, 10, 9, 9, 19), 420)).toBe("2026-11-09 16:19 +07");
		expect(formatNow(Date.UTC(2026, 10, 9, 2, 5), -240)).toBe("2026-11-08 22:05 -04");
	});
});

describe("gapText", () => {
	const base: Gap = { gapMs: 45 * MIN, idle: true, now: Date.UTC(2026, 10, 9, 9, 19), offsetMinutes: 420 };

	it("has two content lines for an idle gap", () => {
		const text = gapText(base);
		expect(text).toBe(
			[
				"<session-gap>",
				"Last activity: 45m ago. Now: 2026-11-09 16:19 +07.",
				"Check facts from before the gap before you act on them.",
				"</session-gap>",
			].join("\n"),
		);
		expect(text.length).toBe(135);
	});

	it("lists the reload", () => {
		expect(gapText({ ...base, pi: "reload" })).toContain("\nSince then: pi reloaded its extensions.\nCheck facts");
	});

	it("drops the check line for a reload alone under the idle threshold", () => {
		const text = gapText({ ...base, gapMs: 20_000, idle: false, pi: "reload" });
		expect(text).toBe(
			[
				"<session-gap>",
				"Last activity: <1m ago. Now: 2026-11-09 16:19 +07.",
				"Since then: pi reloaded its extensions.",
				"</session-gap>",
			].join("\n"),
		);
		expect(text.length).toBe(119);
		const suspended = gapText({ ...base, idle: false, host: { kind: "suspend", ms: 2 * MIN }, pi: "reload" });
		expect(suspended).toContain("\nCheck facts");
	});

	it("lists the suspend alone", () => {
		const text = gapText({ ...base, host: { kind: "suspend", ms: 110 * MIN } });
		expect(text).toContain("\nSince then: the host was suspended for 1h 50m.\nCheck facts");
		expect(text).not.toContain("Lost with");
	});

	it("lists suspend and restart, then the lost work", () => {
		const text = gapText({ ...base, gapMs: 134 * MIN, host: { kind: "suspend", ms: 110 * MIN }, pi: "restart" });
		expect(text).toBe(
			[
				"<session-gap>",
				"Last activity: 2h 14m ago. Now: 2026-11-09 16:19 +07.",
				"Since then: the host was suspended for 1h 50m. pi restarted.",
				"Lost with the old pi process: background jobs, monitors, timers, bus endpoints.",
				"Check facts from before the gap before you act on them.",
				"</session-gap>",
			].join("\n"),
		);
		expect(text.length).toBe(279);
	});

	it("lists the host restart", () => {
		const text = gapText({ ...base, host: { kind: "host-restart" }, pi: "restart" });
		expect(text).toContain("\nSince then: the host restarted. pi restarted.\nLost with the old pi process:");
	});
});

describe("gapSummary", () => {
	it("is one line with the short facts", () => {
		const gap: Gap = {
			gapMs: 134 * MIN,
			idle: true,
			now: 0,
			offsetMinutes: 0,
			host: { kind: "suspend", ms: 110 * MIN },
			pi: "restart",
		};
		expect(gapSummary(gap)).toBe("session gap: 2h 14m · suspended 1h 50m · pi restarted");
		expect(gapSummary({ gapMs: 45 * MIN, idle: true, now: 0, offsetMinutes: 0, pi: "reload" })).toBe(
			"session gap: 45m · pi reloaded",
		);
	});
});

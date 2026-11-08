import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	armedTimers,
	cancelTimer,
	cancelTimers,
	clearAllTimers,
	clockTime,
	createTimerStore,
	fireTimersNow,
	flushTimers,
	listTimers,
	pendingTimers,
	setTimer,
	type TimerStore,
	type TimerWake,
} from "./timers.ts";

const T0 = new Date(2026, 0, 2, 14, 0, 0).getTime();

function bound(sessionId = "s1") {
	const store = createTimerStore();
	const wakes: TimerWake[] = [];
	const notices: string[] = [];
	const changes: string[] = [];
	store.sessionId = sessionId;
	store.wake = (message) => wakes.push(message);
	store.notice = (text) => notices.push(text);
	store.changed = (changedSession) => changes.push(changedSession);
	return { store, wakes, notices, changes };
}

let stores: TimerStore[] = [];
const track = <T extends { store: TimerStore }>(value: T): T => {
	stores.push(value.store);
	return value;
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});
afterEach(() => {
	for (const store of stores) clearAllTimers(store);
	stores = [];
	vi.useRealTimers();
});

describe("timer actions", () => {
	it("sets a timer with a default name and says when it fires", () => {
		const { store } = track(bound());
		const result = setTimer(store, "s1", { delaySeconds: 600, reason: "check CI" }, Date.now());
		expect(result).toEqual({
			ok: true,
			text: `Timer "timer-1" set: fires at ${clockTime(T0 + 600_000)} (in 10m). Timers end with the pi process.`,
		});
		expect(clockTime(T0 + 600_000)).toBe("14:10:00");
		expect(armedTimers(store, "s1")).toEqual([
			{ id: 1, name: "timer-1", sessionId: "s1", reason: "check CI", createdAt: T0, dueAt: T0 + 600_000 },
		]);
	});

	it("counts default names per session", () => {
		const { store } = track(bound());
		setTimer(store, "s1", { delaySeconds: 5, reason: "a" }, T0);
		setTimer(store, "s2", { delaySeconds: 5, reason: "b" }, T0);
		setTimer(store, "s1", { delaySeconds: 5, reason: "c" }, T0);
		expect(armedTimers(store, "s1").map((timer) => timer.name)).toEqual(["timer-1", "timer-2"]);
		expect(armedTimers(store, "s2").map((timer) => timer.name)).toEqual(["timer-1"]);
	});

	it("replaces a timer with the same name in the same session", () => {
		const { store, wakes } = track(bound());
		setTimer(store, "s1", { name: "ci", delaySeconds: 60, reason: "old" }, T0);
		const result = setTimer(store, "s1", { name: "ci", delaySeconds: 120, reason: "new" }, T0);
		expect(result.text).toMatch(/^Timer "ci" replaced: fires at 14:02:00 \(in 2m\)\./);
		expect(armedTimers(store, "s1").map((timer) => timer.reason)).toEqual(["new"]);
		vi.advanceTimersByTime(120_000);
		expect(wakes.map((wake) => wake.details.reason)).toEqual(["new"]);
	});

	it("lists only this session's timers with time, remaining, and reason", () => {
		const { store } = track(bound());
		setTimer(store, "s1", { name: "late", delaySeconds: 3600, reason: "deploy" }, T0);
		setTimer(store, "s1", { name: "soon", delaySeconds: 30, reason: "build" }, T0);
		setTimer(store, "s2", { name: "other", delaySeconds: 30, reason: "x" }, T0);
		expect(listTimers(store, "s1", T0 + 10_000).text).toBe(
			"- soon: fires at 14:00:30 (in 20s). Reason: build\n- late: fires at 15:00:00 (in 59m 50s). Reason: deploy",
		);
		expect(listTimers(store, "s3", T0).text).toBe("No timers are armed in this session.");
	});

	it("cancels by name and refuses an unknown name", () => {
		const { store, wakes } = track(bound());
		setTimer(store, "s1", { name: "ci", delaySeconds: 5, reason: "x" }, T0);
		expect(cancelTimer(store, "s1", "nope")).toEqual({
			ok: false,
			text: 'No timer named "nope" in this session. Armed: ci.',
		});
		expect(cancelTimer(store, "s2", "ci").ok).toBe(false);
		expect(cancelTimer(store, "s1", "ci")).toEqual({ ok: true, text: 'Timer "ci" cancelled.' });
		vi.advanceTimersByTime(10_000);
		expect(wakes).toEqual([]);
	});

	it("allows at most 20 armed timers per session", () => {
		const { store } = track(bound());
		for (let index = 0; index < 20; index++)
			expect(setTimer(store, "s1", { delaySeconds: 5, reason: `r${index}` }, T0).ok).toBe(true);
		expect(setTimer(store, "s1", { delaySeconds: 5, reason: "one more" }, T0)).toEqual({
			ok: false,
			text: "This session has 20 armed timers, the limit. Cancel one first.",
		});
		expect(setTimer(store, "s1", { name: "timer-3", delaySeconds: 9, reason: "replace" }, T0).ok).toBe(true);
		expect(setTimer(store, "s2", { delaySeconds: 5, reason: "other session" }, T0).ok).toBe(true);
	});

	it.each([
		[{ reason: "x" }, "set requires delaySeconds."],
		[{ delaySeconds: 0, reason: "x" }, "delaySeconds must be an integer from 1 to 604800."],
		[{ delaySeconds: 604_801, reason: "x" }, "delaySeconds must be an integer from 1 to 604800."],
		[{ delaySeconds: 1.5, reason: "x" }, "delaySeconds must be an integer from 1 to 604800."],
		[{ delaySeconds: 5 }, "set requires a reason."],
		[{ delaySeconds: 5, reason: "  " }, "set requires a reason."],
		[{ delaySeconds: 5, reason: "x".repeat(501) }, "reason is at most 500 characters."],
		[{ delaySeconds: 5, reason: "x", name: "" }, "name must be 1 to 64 characters."],
		[{ delaySeconds: 5, reason: "x", name: "n".repeat(65) }, "name must be 1 to 64 characters."],
	])("rejects %j", (params, text) => {
		const { store } = track(bound());
		expect(setTimer(store, "s1", params, T0)).toEqual({ ok: false, text });
		expect(armedTimers(store, "s1")).toEqual([]);
	});
});

describe("timer delivery", () => {
	it("wakes the bound session with the reason when it fires", () => {
		const { store, wakes } = track(bound());
		setTimer(store, "s1", { name: "ci", delaySeconds: 600, reason: "check CI" }, T0);
		vi.advanceTimersByTime(599_999);
		expect(wakes).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(wakes).toEqual([
			{
				customType: "timer",
				content: 'Timer "ci" fired (set 10m ago). Reason: check CI',
				display: true,
				details: { name: "ci", reason: "check CI", createdAt: T0, dueAt: T0 + 600_000 },
			},
		]);
		expect(armedTimers(store, "s1")).toEqual([]);
	});

	it("shows a timer of another session as a notice, without a wake", () => {
		const { store, wakes, notices } = track(bound("s2"));
		setTimer(store, "s1", { name: "ci", delaySeconds: 5, reason: "check CI" }, T0);
		vi.advanceTimersByTime(5_000);
		expect(wakes).toEqual([]);
		expect(notices).toEqual(['Timer "ci" of another session fired: check CI']);
	});

	it("queues a timer that fires while no runtime is bound and delivers it at the next bind", () => {
		const { store, wakes } = track(bound());
		const wake = store.wake;
		store.wake = undefined;
		setTimer(store, "s1", { delaySeconds: 5, reason: "later" }, T0);
		vi.advanceTimersByTime(5_000);
		expect(store.queue).toHaveLength(1);
		store.wake = wake;
		flushTimers(store);
		expect(wakes.map((item) => item.details.reason)).toEqual(["later"]);
		expect(store.queue).toEqual([]);
	});

	it("keeps a timer whose wake throws for the next bind", () => {
		const { store } = track(bound());
		store.wake = () => {
			throw new Error("Extension runtime not initialized");
		};
		setTimer(store, "s1", { delaySeconds: 5, reason: "later" }, T0);
		vi.advanceTimersByTime(5_000);
		expect(store.queue.map((timer) => timer.reason)).toEqual(["later"]);
	});

	it("fires matching timers now in creation order and cancels by filter", () => {
		const { store, wakes } = track(bound());
		setTimer(store, "s1", { name: "old", delaySeconds: 50, reason: "before goal" }, T0);
		setTimer(store, "s1", { name: "b", delaySeconds: 90, reason: "second" }, T0 + 10);
		setTimer(store, "s1", { name: "a", delaySeconds: 30, reason: "third" }, T0 + 20);
		setTimer(store, "s2", { name: "c", delaySeconds: 30, reason: "other" }, T0 + 20);
		expect(fireTimersNow(store, { sessionId: "s1", createdSince: T0 + 10 })).toBe(2);
		expect(wakes.map((wake) => wake.details.name)).toEqual(["b", "a"]);
		expect(armedTimers(store, "s1").map((timer) => timer.name)).toEqual(["old"]);
		expect(cancelTimers(store, { sessionId: "s1", createdSince: T0 + 1 })).toBe(0);
		expect(cancelTimers(store, { sessionId: "s1" })).toBe(1);
		expect(armedTimers(store, "s2")).toHaveLength(1);
	});

	it("a notice that throws does not escape the fire callback", () => {
		const { store } = track(bound("s2"));
		store.notice = () => {
			throw new Error("stale context");
		};
		setTimer(store, "s1", { delaySeconds: 5, reason: "x" }, T0);
		expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
	});

	it("lists the fired timers of a session that wait for the next bind", () => {
		const { store } = track(bound());
		store.wake = undefined;
		setTimer(store, "s1", { name: "a", delaySeconds: 5, reason: "x" }, T0);
		setTimer(store, "s2", { name: "b", delaySeconds: 5, reason: "y" }, T0);
		vi.advanceTimersByTime(5_000);
		expect(pendingTimers(store, "s1").map((timer) => timer.name)).toEqual(["a"]);
		expect(pendingTimers(store, "s3")).toEqual([]);
	});

	it("reports each change with its session after the change", () => {
		const { store, changes, wakes } = track(bound());
		const seen: number[] = [];
		store.changed = (sessionId) => {
			changes.push(sessionId);
			seen.push(armedTimers(store, sessionId).length + wakes.length * 100);
		};
		setTimer(store, "s1", { name: "a", delaySeconds: 5, reason: "x" }, T0);
		setTimer(store, "s1", { name: "a", delaySeconds: 6, reason: "x" }, T0);
		cancelTimer(store, "s1", "a");
		setTimer(store, "s2", { name: "b", delaySeconds: 5, reason: "y" }, T0);
		vi.advanceTimersByTime(5_000);
		setTimer(store, "s1", { name: "c", delaySeconds: 5, reason: "z" }, T0);
		fireTimersNow(store, { sessionId: "s1" });
		setTimer(store, "s1", { name: "d", delaySeconds: 5, reason: "z" }, T0);
		cancelTimers(store, { sessionId: "s1" });
		cancelTimers(store, { sessionId: "s1" });
		setTimer(store, "s3", { name: "e", delaySeconds: 5, reason: "z" }, T0);
		clearAllTimers(store);
		expect(changes).toEqual(["s1", "s1", "s1", "s2", "s2", "s1", "s1", "s1", "s1", "s3", "s3"]);
		expect(seen.slice(0, 3)).toEqual([1, 1, 0]);
		expect(seen[6]).toBe(100);
	});

	it("clears every handle on quit", () => {
		const { store, wakes } = track(bound());
		setTimer(store, "s1", { delaySeconds: 5, reason: "a" }, T0);
		setTimer(store, "s2", { delaySeconds: 5, reason: "b" }, T0);
		clearAllTimers(store);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(wakes).toEqual([]);
	});
});

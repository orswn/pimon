import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	controlAllowed,
	FORCE_EXIT_MS,
	FORCE_POLL_MS,
	type ForcedCloseDeps,
	RETRY_SHUTDOWN_MS,
	scheduleForcedClose,
} from "./control.ts";

function deps(state: { idle: boolean; retired?: boolean; stale?: boolean }) {
	const calls = { shutdown: 0, exit: 0 };
	const value: ForcedCloseDeps = {
		retired: () => state.retired === true,
		shutdown: () => {
			calls.shutdown++;
		},
		isIdle: () => {
			if (state.stale) throw new Error("stale context");
			return state.idle;
		},
		exit: async () => {
			calls.exit++;
		},
	};
	return { value, calls };
}

describe("forced close after a close request", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("asks again, then exits once the session is idle", () => {
		const { value, calls } = deps({ idle: true });
		scheduleForcedClose(value);
		vi.advanceTimersByTime(RETRY_SHUTDOWN_MS);
		expect(calls).toEqual({ shutdown: 1, exit: 0 });
		vi.advanceTimersByTime(FORCE_EXIT_MS - RETRY_SHUTDOWN_MS);
		expect(calls.exit).toBe(1);
	});

	it("never exits while busy and exits after the run ends", () => {
		const state = { idle: false };
		const { value, calls } = deps(state);
		scheduleForcedClose(value);
		vi.advanceTimersByTime(FORCE_EXIT_MS + FORCE_POLL_MS * 5);
		expect(calls.exit).toBe(0);
		state.idle = true;
		vi.advanceTimersByTime(FORCE_POLL_MS);
		expect(calls.exit).toBe(1);
	});

	it("does nothing after the runtime retired or with a stale context", () => {
		const retired = deps({ idle: true, retired: true });
		scheduleForcedClose(retired.value);
		vi.advanceTimersByTime(FORCE_EXIT_MS * 2);
		expect(retired.calls).toEqual({ shutdown: 0, exit: 0 });

		const stale = deps({ idle: true, stale: true });
		scheduleForcedClose(stale.value);
		vi.advanceTimersByTime(FORCE_EXIT_MS * 2);
		expect(stale.calls.exit).toBe(0);
	});

	it("cancels every timer", () => {
		const { value, calls } = deps({ idle: true });
		const cancel = scheduleForcedClose(value);
		cancel();
		vi.advanceTimersByTime(FORCE_EXIT_MS * 2);
		expect(calls).toEqual({ shutdown: 0, exit: 0 });
	});
});

describe("control permission", () => {
	const parent = "a".repeat(32);
	const envelope = (token?: string) =>
		({
			kind: "control",
			from: { owner: parent, instanceId: "b".repeat(32) },
			data: token ? { token } : undefined,
		}) as unknown as Parameters<typeof controlAllowed>[0];

	it("accepts the parent without a token only when no token is required", () => {
		expect(controlAllowed(envelope(), "parent", undefined, parent)).toBe(true);
		expect(controlAllowed(envelope(), "parent", undefined, parent, true)).toBe(false);
		expect(controlAllowed(envelope("t"), "parent", "t", parent, true)).toBe(true);
	});
});

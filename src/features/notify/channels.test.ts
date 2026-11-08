import { describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecOptions, ExecResult } from "../../core/exec.ts";
import { createNotifier, defaultTitle, formatOutcome, type NotifyKind } from "./channels.ts";

const T0 = 1_700_000_000_000;
const ok: ExecResult = { code: 0, stdout: "", stderr: "" };

interface Call {
	command: string;
	args: string[];
	options?: ExecOptions | undefined;
}

function recorder(
	listing = "aaaaaaaa_1111_2222_3333_444444444444\n_bbbbbbbb_5555_6666_7777_888888888888_\n2 devices found\n",
) {
	const calls: Call[] = [];
	const exec: ExecFn = async (command, args, options) => {
		calls.push({ command, args, options });
		if (command === "kdeconnect-cli" && args[0] === "-a") return { code: 0, stdout: listing, stderr: "" };
		return ok;
	};
	const line = (call: Call) => `${call.command} ${call.args.join(" ")}`;
	return { calls, exec, lines: () => calls.map(line) };
}

describe("notifier", () => {
	it("reaches the desktop and every device, with critical urgency and the detail", async () => {
		const { exec, lines } = recorder();
		const outcome = await createNotifier({ exec, now: () => T0 }).notify({
			kind: "blocked",
			message: "needs a decision",
			detail: "which database",
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.delivered).toEqual(["desktop", "2 phones"]);
		expect(lines().some((call) => call.includes("-u critical"))).toBe(true);
		expect(lines().some((call) => call.includes("which database"))).toBe(true);
		expect(lines().filter((call) => call.includes("--ping-msg"))).toHaveLength(2);
		expect(lines().some((call) => call.includes("2 devices found"))).toBe(false);
	});

	it("suppresses an identical notification until the dedupe window passes", async () => {
		const { exec } = recorder();
		let clock = T0;
		const notifier = createNotifier({ exec, now: () => clock });
		await notifier.notify({ kind: "blocked", message: "needs a decision" });
		expect((await notifier.notify({ kind: "blocked", message: "needs a decision" })).suppressed).toBe("duplicate");
		clock += 61_000;
		expect((await notifier.notify({ kind: "blocked", message: "needs a decision" })).ok).toBe(true);
	});

	it("does not suppress the same message with another detail", async () => {
		const { exec } = recorder();
		const notifier = createNotifier({ exec, now: () => T0 });
		await notifier.notify({ kind: "paused", message: "Goal paused: run-lost", detail: "first" });
		const second = await notifier.notify({ kind: "paused", message: "Goal paused: run-lost", detail: "second" });
		expect(second.suppressed).toBeUndefined();
		expect(second.ok).toBe(true);
		const third = await notifier.notify({ kind: "paused", message: "Goal paused: run-lost", detail: "second" });
		expect(third.suppressed).toBe("duplicate");
	});

	it("mutes a flood and names the cause", async () => {
		const { exec } = recorder();
		const notifier = createNotifier({ exec, now: () => T0 });
		for (let index = 0; index < 6; index++) await notifier.notify({ kind: "info", message: `m${index}` });
		const flooded = await notifier.notify({ kind: "info", message: "one too many" });
		expect(flooded.suppressed).toBe("rate-limit");
		expect(formatOutcome(flooded)).toContain("muted");
	});

	it.each(["blocked", "paused", "unverified"] as const)(
		"never mutes %s, but counts it against the window",
		async (kind) => {
			const { exec } = recorder();
			const notifier = createNotifier({ exec, now: () => T0 });
			for (let index = 0; index < 6; index++) await notifier.notify({ kind: "info", message: `m${index}` });
			const urgent = await notifier.notify({ kind, message: "the goal stopped" });
			expect(urgent.suppressed).toBeUndefined();
			expect(urgent.ok).toBe(true);
			expect((await notifier.notify({ kind: "info", message: "after" })).suppressed).toBe("rate-limit");
			expect((await notifier.notify({ kind, message: "the goal stopped again" })).ok).toBe(true);
		},
	);

	it("counts urgent kinds, so they push info into the mute", async () => {
		const { exec } = recorder();
		const notifier = createNotifier({ exec, now: () => T0 });
		for (let index = 0; index < 6; index++) await notifier.notify({ kind: "blocked", message: `b${index}` });
		expect((await notifier.notify({ kind: "info", message: "x" })).suppressed).toBe("rate-limit");
	});

	it("forgets a delivery once the dedupe window passes", async () => {
		const { exec } = recorder();
		let clock = T0;
		const notifier = createNotifier({ exec, now: () => clock, maxPerMinute: 100 });
		await notifier.notify({ kind: "info", message: "same" });
		clock += 30_000;
		expect((await notifier.notify({ kind: "info", message: "same" })).suppressed).toBe("duplicate");
		clock += 31_000;
		expect((await notifier.notify({ kind: "info", message: "same" })).ok).toBe(true);
	});

	it("reports a total failure, names the channels, and says the user has not seen it", async () => {
		const dead = createNotifier({
			exec: async (command, args) =>
				command === "kdeconnect-cli" && args[0] === "-a"
					? { code: 1, stdout: "", stderr: "" }
					: { code: 1, stdout: "", stderr: "no session bus" },
			now: () => T0,
		});
		const outcome = await dead.notify({ kind: "paused", message: "budget" });
		expect(outcome.ok).toBe(false);
		expect(outcome.failed.length).toBeGreaterThanOrEqual(2);
		expect(formatOutcome(outcome)).toContain("NOT delivered");
	});

	it("does not throw when every exec throws", async () => {
		const throwing = createNotifier({
			exec: async () => {
				throw new Error("ENOENT");
			},
			now: () => T0,
		});
		expect((await throwing.notify({ kind: "done", message: "x" })).ok).toBe(false);
	});
});

describe("notification failures are retryable", () => {
	it("retries after a failure and suppresses only after a delivery", async () => {
		let mode = "fail";
		const exec: ExecFn = async (command, args) => {
			if (command === "kdeconnect-cli" && args[0] === "-a")
				return { code: 0, stdout: "aaaaaaaa_1111_2222_3333_444444444444\n", stderr: "" };
			return mode === "fail" ? { code: 1, stdout: "", stderr: "no bus" } : ok;
		};
		let clock = T0;
		const notifier = createNotifier({ exec, now: () => clock });
		expect((await notifier.notify({ kind: "paused", message: "deadline" })).ok).toBe(false);
		clock += 100;
		expect((await notifier.notify({ kind: "paused", message: "deadline" })).suppressed).not.toBe("duplicate");
		mode = "ok";
		clock += 100;
		expect((await notifier.notify({ kind: "paused", message: "deadline" })).ok).toBe(true);
		clock += 100;
		expect((await notifier.notify({ kind: "paused", message: "deadline" })).suppressed).toBe("duplicate");
	});
});

describe("phone channel names", () => {
	const twoIds = "aaaaaaaa_1111_2222_3333_444444444444\nbbbbbbbb_5555_6666_7777_888888888888\n";
	const pingResults = (results: ExecResult[]): ExecFn => {
		let index = 0;
		return async (command, args) => {
			if (command === "kdeconnect-cli" && args[0] === "-a") return { code: 0, stdout: twoIds, stderr: "" };
			if (command === "kdeconnect-cli") return results[index++] ?? ok;
			return ok;
		};
	};

	it("names phones by count, never by device id", async () => {
		const outcome = await createNotifier({ exec: pingResults([ok, ok]), now: () => T0 }).notify({
			kind: "info",
			message: "x",
		});
		expect(formatOutcome(outcome)).toBe("Notified via desktop, 2 phones.");
	});

	it("names a failed phone with its cause and groups phones with the same cause", async () => {
		const failed: ExecResult = { code: 1, stdout: "", stderr: "" };
		const one = await createNotifier({ exec: pingResults([ok, failed]), now: () => T0 }).notify({
			kind: "info",
			message: "x",
		});
		expect(formatOutcome(one)).toBe("Notified via desktop, phone (failed: phone(1)).");
		const both = await createNotifier({ exec: pingResults([failed, failed]), now: () => T0 }).notify({
			kind: "info",
			message: "x",
		});
		expect(formatOutcome(both)).toBe("Notified via desktop (failed: 2 phones(1)).");
	});
});

describe("device discovery reports the cause", () => {
	const withListing = (listing: ExecResult) =>
		createNotifier({
			exec: async (command, args) => (command === "kdeconnect-cli" && args[0] === "-a" ? listing : ok),
			now: () => T0,
		});

	it("tells a failed listing from no devices and keeps the daemon error", async () => {
		const outcome = await withListing({ code: 1, stdout: "", stderr: "daemon not running" }).notify({
			kind: "info",
			message: "x",
		});
		expect(outcome.failed.some((entry) => entry.includes("device-listing-exit-1"))).toBe(true);
		expect(outcome.failed.some((entry) => entry.includes("daemon not running"))).toBe(true);
	});
	it("names a listing timeout", async () => {
		const outcome = await withListing({ code: -1, stdout: "", stderr: "", failed: "timeout" }).notify({
			kind: "info",
			message: "y",
		});
		expect(outcome.failed).toContain("device-listing-timeout");
	});
	it("says no-reachable-device when there are none", async () => {
		const outcome = await withListing({ code: 0, stdout: "", stderr: "" }).notify({ kind: "info", message: "z" });
		expect(outcome.failed).toContain("no-reachable-device");
	});
	it("does not treat prose lines as device ids", async () => {
		const outcome = await withListing({
			code: 0,
			stdout: "- terra: id_here (paired)\nreal_id_0001\n",
			stderr: "",
		}).notify({ kind: "info", message: "w" });
		expect(outcome.delivered.filter((entry) => entry !== "desktop")).toHaveLength(1);
	});
});

describe("titles", () => {
	it.each<[NotifyKind, string]>([
		["info", "pi"],
		["blocked", "pi: blocked, needs you"],
		["done", "pi: done"],
		["paused", "pi: paused"],
		["unverified", "pi: stopped, unverified"],
	])("%s defaults to %s without the word goal", (kind, title) => {
		expect(defaultTitle(kind)).toBe(title);
	});

	it("uses the default title on the desktop and the phone", async () => {
		const { exec, calls } = recorder("real_id_0001\n");
		await createNotifier({ exec, now: () => T0 }).notify({ kind: "info", message: "build finished" });
		expect(calls.find((call) => call.command === "notify-send")?.args).toContain("pi");
		expect(calls.find((call) => call.args.includes("--ping-msg"))?.args.at(-1)).toBe("pi: build finished");
	});

	it("uses a caller title", async () => {
		const { exec, calls } = recorder("real_id_0001\n");
		await createNotifier({ exec, now: () => T0 }).notify({ kind: "paused", title: "pi goal: paused", message: "m" });
		expect(calls.find((call) => call.command === "notify-send")?.args).toContain("pi goal: paused");
		expect(calls.find((call) => call.args.includes("--ping-msg"))?.args.at(-1)).toBe("pi goal: paused: m");
	});
});

describe("fan-out", () => {
	it("starts the desktop and the phone listing before either finishes", async () => {
		const started: string[] = [];
		const release: (() => void)[] = [];
		const exec: ExecFn = (command, args) => {
			started.push(`${command} ${args[0]}`);
			return new Promise((resolve) => {
				release.push(() =>
					resolve(command === "kdeconnect-cli" && args[0] === "-a" ? { code: 0, stdout: "", stderr: "" } : ok),
				);
			});
		};
		const pending = createNotifier({ exec, now: () => T0 }).notify({ kind: "info", message: "x" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(started).toEqual(["notify-send -a", "kdeconnect-cli -a"]);
		for (const go of release) go();
		expect((await pending).delivered).toEqual(["desktop"]);
	});

	it("pings every device in parallel", async () => {
		let inFlight = 0;
		let peak = 0;
		const exec: ExecFn = async (command, args) => {
			if (command === "kdeconnect-cli" && args[0] === "-a")
				return { code: 0, stdout: "aaaa1111\nbbbb2222\n", stderr: "" };
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight--;
			return ok;
		};
		await createNotifier({ exec, now: () => T0 }).notify({ kind: "info", message: "x" });
		expect(peak).toBe(3);
	});

	it("passes the signal to every exec, and an abort ends the fan-out", async () => {
		const controller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		const exec: ExecFn = (_command, _args, options) => {
			signals.push(options?.signal);
			return new Promise((resolve) => {
				options?.signal?.addEventListener("abort", () =>
					resolve({ code: -1, stdout: "", stderr: "cancelled", failed: "aborted" }),
				);
			});
		};
		const pending = createNotifier({ exec, now: () => T0 }).notify({
			kind: "info",
			message: "x",
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		const outcome = await pending;
		expect(signals).toEqual([controller.signal, controller.signal]);
		expect(outcome.ok).toBe(false);
		expect(outcome.failed).toContain("device-listing-aborted");
	});
});

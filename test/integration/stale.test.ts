import { writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature, type FeatureContext } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import type { Clock } from "../../src/features/stale/gap.ts";
import { createStale } from "../../src/features/stale/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const skew = { wall: 0, mono: 0, uptime: 0 };
const host = { bootId: "boot-a" as string | undefined };
// os.uptime() has a 10 ms step. Read raw, it puts up to 10 ms of false suspend into each gap, and a
// suspend of 2m can show as 1m. So uptime runs on the same monotonic clock and differs only by the skew.
const baseMono = process.hrtime.bigint();
const baseUptime = uptime();
const clock: Clock = {
	now: () => {
		const mono = process.hrtime.bigint();
		return {
			wall: Date.now() + skew.wall,
			mono: mono + BigInt(skew.mono) * 1_000_000n,
			uptime: baseUptime + Number(mono - baseMono) / 1e9 + skew.uptime / 1000,
		};
	},
	offsetMinutes: () => 420,
	bootId: () => host.bootId,
};
const realBootTime = () => Math.round((Date.now() - uptime() * 1000) / 1000);
const advance = (ms: number, suspendedMs = 0) => {
	skew.wall += ms;
	skew.uptime += ms;
	skew.mono += ms - suspendedMs;
};
const stale = createStale(clock);

let waker: FeatureContext<unknown> | undefined;
const wakerFeature = defineFeature({
	id: "waker",
	description: "test feature that wakes the model",
	defaultEnabled: true,
	setup(ctx) {
		waker = ctx as FeatureContext<unknown>;
	},
});

const say = (text: string) => fauxAssistantMessage(fauxText(text));
const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
// Only the messages that started this request, after the last answer.
const gapsIn = (messages: Message[] | undefined) => {
	const all = messages ?? [];
	const lastAnswer = all.findLastIndex((message) => message.role === "assistant");
	return all
		.slice(lastAnswer + 1)
		.map(textOf)
		.filter((text) => text.startsWith("<session-gap>"));
};

const savedStamps = (h: Harness) =>
	h.session.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "pimon-stale" ? [entry.data] : []));
const savedBoots = (h: Harness) =>
	h.session.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "pimon-stale"
				? [(entry.data as { bootTime: number }).bootTime]
				: [],
		);

function oldSession(ageMs: number, extra?: (manager: SessionManager) => void) {
	return (cwd: string) => {
		const manager = SessionManager.inMemory(cwd);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "old question" }], timestamp: 0 });
		manager.appendMessage(say("old answer"));
		const old = new Date(Date.now() - ageMs).toISOString();
		for (const entry of manager.getEntries()) entry.timestamp = old;
		extra?.(manager);
		return manager;
	};
}

describe("stale", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		waker = undefined;
		skew.wall = 0;
		skew.mono = 0;
		skew.uptime = 0;
		host.bootId = "boot-a";
		clearReloadState();
	});

	const start = async (options: Partial<HarnessOptions> = {}) => {
		harness = await createHarness({ features: [stale], ...options });
		return harness;
	};

	it("sends nothing without a gap", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		advance(29 * MIN);
		await h.session.prompt("second");
		expect(h.requests.flatMap(gapsIn)).toEqual([]);
	});

	it("reports an idle gap from the last entry, not from the starting message", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		advance(31 * MIN);
		await h.session.prompt("second");
		const [gap] = gapsIn(h.requests[1]);
		expect(gap).toMatch(/^<session-gap>\nLast activity: 31m ago\. Now: \d{4}-\d\d-\d\d \d\d:\d\d \+07\.\nCheck facts/);
		expect(gap).not.toContain("Since then");
		const last = h.requests[1]?.at(-1);
		expect(last && textOf(last)).toBe(gap);
		const stored = h.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "pimon-stale");
		expect(stored).toMatchObject([{ display: true }]);
	});

	it("sends the notice once after a reload", async () => {
		const h = await start();
		h.respond([say("one"), say("two"), say("three")]);
		await h.session.prompt("before");
		await h.session.reload();
		await h.session.prompt("after");
		await h.session.prompt("again");
		expect(gapsIn(h.requests[0])).toEqual([]);
		expect(gapsIn(h.requests[1])).toEqual([expect.stringContaining("\nSince then: pi reloaded its extensions.\n</")]);
		expect(gapsIn(h.requests[1])[0]).not.toContain("Lost with");
		expect(gapsIn(h.requests[1])[0]).not.toContain("Check facts");
		expect(gapsIn(h.requests[2])).toEqual([]);
	});

	it("keeps the check line for a reload after an idle gap", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("before");
		advance(31 * MIN);
		await h.session.reload();
		await h.session.prompt("after");
		expect(gapsIn(h.requests[1])).toEqual([
			expect.stringContaining("\nSince then: pi reloaded its extensions.\nCheck facts"),
		]);
	});

	it("keeps a pending restart and host restart across a reload before the first run", async () => {
		const h = await start({
			sessionManager: oldSession(3 * DAY, (manager) =>
				manager.appendCustomEntry("pimon-stale", { bootTime: realBootTime(), bootId: "boot-old" }),
			),
		});
		h.respond([say("one"), say("two")]);
		await h.session.reload();
		await h.session.prompt("back");
		await h.session.prompt("again");
		expect(gapsIn(h.requests[0])).toEqual([
			expect.stringContaining(
				"\nSince then: the host restarted. pi restarted.\nLost with the old pi process: background jobs, monitors, timers, bus endpoints.\n",
			),
		]);
		expect(gapsIn(h.requests[1])).toEqual([]);
	});

	it("does not count a custom message stored while idle as activity", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		advance(31 * MIN);
		await h.session.sendCustomMessage({ customType: "bus", content: "peer exited", display: true });
		const stored = h.session.sessionManager.getBranch().at(-1);
		expect(stored?.type).toBe("custom_message");
		if (stored) stored.timestamp = new Date(Date.now() + 30 * MIN).toISOString();
		await h.session.prompt("second");
		expect(gapsIn(h.requests[1])).toEqual([expect.stringContaining("Last activity: 31m ago.")]);
	});

	it("reports a suspend of this process", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		advance(5 * MIN, 2 * MIN);
		await h.session.prompt("second");
		expect(gapsIn(h.requests[1])).toEqual([expect.stringContaining("Last activity: 5m ago. Now:")]);
		expect(gapsIn(h.requests[1])[0]).toContain("\nSince then: the host was suspended for 2m.\n");
	});

	it("reports the real gap and the lost work on a restart into an old session", async () => {
		const h = await start({ sessionManager: oldSession(3 * DAY + 2 * 60 * MIN) });
		h.respond([say("one"), say("two")]);
		await h.session.prompt("back");
		await h.session.prompt("again");
		const [gap] = gapsIn(h.requests[0]);
		expect(gap).toContain("Last activity: 3d 2h ago.");
		expect(gap).toContain(
			"\nSince then: pi restarted.\nLost with the old pi process: background jobs, monitors, timers, bus endpoints.\n",
		);
		expect(gapsIn(h.requests[1])).toEqual([]);
	});

	it("does not count custom entries or model changes as activity", async () => {
		const h = await start({
			sessionManager: oldSession(2 * 60 * MIN, (manager) => {
				manager.appendCustomEntry("pimon-goal", { state: "active" });
				manager.appendModelChange("faux", "other");
			}),
		});
		h.respond([say("one")]);
		await h.session.prompt("back");
		expect(gapsIn(h.requests[0])[0]).toContain("Last activity: 2h ago.");
	});

	it("reports a host restart from the saved boot time when the entry has no boot id", async () => {
		const bootTime = realBootTime() - 3600;
		const h = await start({
			sessionManager: oldSession(10 * MIN, (manager) => manager.appendCustomEntry("pimon-stale", { bootTime })),
		});
		h.respond([say("one")]);
		await h.session.prompt("back");
		const [gap] = gapsIn(h.requests[0]);
		expect(gap).toContain("\nSince then: the host restarted. pi restarted.\nLost with the old pi process:");
		expect(savedBoots(h)).toEqual([bootTime, expect.closeTo(bootTime + 3600, -1)]);
		expect(savedStamps(h).at(-1)).toMatchObject({ bootId: "boot-a" });
	});

	it("reports a host restart from a changed boot id", async () => {
		const h = await start({
			sessionManager: oldSession(10 * MIN, (manager) =>
				manager.appendCustomEntry("pimon-stale", { bootTime: realBootTime(), bootId: "boot-old" }),
			),
		});
		h.respond([say("one")]);
		await h.session.prompt("back");
		expect(gapsIn(h.requests[0])[0]).toContain("\nSince then: the host restarted. pi restarted.\n");
	});

	it("trusts the boot id over a moved boot time", async () => {
		const h = await start({
			sessionManager: oldSession(10 * MIN, (manager) =>
				manager.appendCustomEntry("pimon-stale", { bootTime: realBootTime() - 3600, bootId: "boot-a" }),
			),
		});
		h.respond([say("one")]);
		await h.session.prompt("back");
		expect(gapsIn(h.requests[0])[0]).toContain("\nSince then: pi restarted.\n");
		expect(savedStamps(h)).toHaveLength(1);
	});

	it("saves the boot time once per boot without sending it to the model", async () => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		await h.session.reload();
		await h.session.reload();
		await h.session.prompt("second");
		expect(savedBoots(h)).toEqual([expect.any(Number)]);
		expect(JSON.stringify(h.requests)).not.toContain("bootTime");
	});

	it("adds no boot time entry on a restart in the same boot", async () => {
		const bootTime = realBootTime() - 3;
		const h = await start({
			sessionManager: oldSession(10 * MIN, (manager) =>
				manager.appendCustomEntry("pimon-stale", { bootTime, bootId: "boot-a" }),
			),
		});
		h.respond([say("one")]);
		await h.session.prompt("back");
		expect(gapsIn(h.requests[0])[0]).toContain("\nSince then: pi restarted.\n");
		expect(savedBoots(h)).toEqual([bootTime]);
	});

	it("resume reason: a session this process has seen is no restart, but keeps the idle check", async () => {
		const h = await start();
		h.respond([say("one"), say("two"), say("three")]);
		await h.session.prompt("first");
		h.session.sessionManager.appendCustomEntry("pimon-stale", { bootTime: 1 });
		await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		await h.session.prompt("second");
		advance(31 * MIN);
		await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		await h.session.prompt("third");
		expect(gapsIn(h.requests[1])).toEqual([]);
		expect(gapsIn(h.requests[2])).toEqual([expect.stringContaining("Last activity: 31m ago.")]);
		expect(gapsIn(h.requests[2])[0]).not.toContain("Since then");
		expect(gapsIn(h.requests[2])[0]).not.toContain("Lost with");
	});

	it("resume reason: a session this process has not seen is a restart with the host check", async () => {
		const h = await start();
		h.respond([say("one"), say("two"), say("three")]);
		await h.session.prompt("first");
		const manager = h.session.sessionManager;
		manager.newSession();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: 0 });
		manager.appendMessage(say("other answer"));
		manager.appendCustomEntry("pimon-stale", { bootTime: realBootTime(), bootId: "boot-old" });
		await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		await h.session.prompt("second");
		await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		await h.session.prompt("third");
		expect(gapsIn(h.requests[1])).toEqual([
			expect.stringContaining("\nSince then: the host restarted. pi restarted.\nLost with the old pi process:"),
		]);
		expect(gapsIn(h.requests[2])).toEqual([]);
	});

	it.each(["new", "fork"] as const)("new and fork reasons: %s is no restart", async (reason) => {
		const h = await start();
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		const manager = h.session.sessionManager;
		manager.newSession();
		if (reason === "fork") {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: "copied" }], timestamp: 0 });
			manager.appendMessage(say("copied answer"));
		}
		await h.session.extensionRunner.emit({ type: "session_start", reason });
		await h.session.prompt("second");
		expect(gapsIn(h.requests[1])).toEqual([]);
	});

	it("sends nothing in a new empty session", async () => {
		const h = await start();
		h.respond([say("one")]);
		await h.session.prompt("hello");
		expect(gapsIn(h.requests[0])).toEqual([]);
	});

	it("adds the notice to a wake after an idle gap", async () => {
		const h = await start({ features: [stale, wakerFeature] });
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		advance(45 * MIN);
		waker?.wake({ customType: "waker", content: "timer fired", display: true });
		await h.waitForRequests(2);
		const texts = (h.requests[1] ?? []).map(textOf);
		expect(texts.slice(-2)).toEqual(["timer fired", expect.stringContaining("Last activity: 45m ago.")]);
	});

	it("uses the idleMinutes option", async () => {
		const h = await start({
			setupAgentDir: (dir) =>
				writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { stale: { idleMinutes: 5 } } })),
		});
		h.respond([say("one"), say("two"), say("three")]);
		await h.session.prompt("first");
		advance(4 * MIN);
		await h.session.prompt("second");
		advance(MIN);
		await h.session.prompt("third");
		expect(gapsIn(h.requests[1])).toEqual([]);
		// Entries carry the real time, so the skew adds up to 5 minutes.
		expect(gapsIn(h.requests[2])).toEqual([expect.stringContaining("Last activity: 5m ago.")]);
	});

	it("sends nothing when the feature is off", async () => {
		const h = await start({
			sessionManager: oldSession(DAY),
			setupAgentDir: (dir) => writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { stale: false } })),
		});
		h.respond([say("one"), say("two")]);
		await h.session.prompt("first");
		await h.session.reload();
		await h.session.prompt("second");
		expect(h.requests.flatMap(gapsIn)).toEqual([]);
		expect(h.session.sessionManager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
	});
});

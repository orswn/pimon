import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defineFeature, type WakeMessage } from "../../src/core/feature.ts";
import { clearReloadState, reloadSlot } from "../../src/core/reload-state.ts";
import { background } from "../../src/features/background/index.ts";
import { clearAllTimers, createTimerStore, setTimer, type TimerStore } from "../../src/features/background/timers.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
const timerStore = () => reloadSlot<TimerStore>("background", "timers", 1, createTimerStore);

const filtered: WakeMessage[] = [];
const probe = defineFeature({
	id: "timer-probe",
	description: "test probe",
	defaultEnabled: true,
	setup(ctx) {
		ctx.wakeFilter((message) => {
			filtered.push(message);
			return message;
		});
		ctx.pi.registerTool({
			name: "script_timer",
			label: "Script timer",
			description: "test tool that sets a timer from inside a tool, like a codemode script",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, toolCtx) {
				const outcome = await toolCtx.executeTool("timer", { action: "set", delaySeconds: 60, reason: "nested" });
				return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: {} };
			},
		});
	},
});

let harness: Harness | undefined;

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	clearAllTimers(timerStore());
	harness?.dispose();
	harness = undefined;
	filtered.length = 0;
	clearReloadState();
	vi.useRealTimers();
});

async function start(ui = false, hostBindings = true): Promise<Harness> {
	harness = await createHarness({ features: [background, probe], hostBindings, ...(ui ? { ui: {} } : {}) });
	return harness;
}

async function idle(h: Harness) {
	await vi.advanceTimersByTimeAsync(50);
	await h.session.waitForIdle();
}

describe("timer tool", () => {
	it("sets, lists, replaces, and cancels timers of this session", async () => {
		const h = await start();
		h.respond([
			call("timer", { action: "set", name: "ci", delaySeconds: 600, reason: "check CI" }),
			call("timer", { action: "set", name: "ci", delaySeconds: 60, reason: "check CI sooner" }),
			call("timer", { action: "list" }),
			call("timer", { action: "cancel", name: "ci" }),
			call("timer", { action: "cancel", name: "ci" }),
			say("done"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(6);

		const results = toolTexts(h.requests[5]);
		expect(results[0]).toMatch(
			/^Timer "ci" set: fires at \d\d:\d\d:\d\d \(in 10m\)\. Timers end with the pi process\.$/,
		);
		expect(results[1]).toMatch(/^Timer "ci" replaced: fires at \d\d:\d\d:\d\d \(in 60s\)\./);
		expect(results[2]).toMatch(/^- ci: fires at \d\d:\d\d:\d\d \(in 60s\)\. Reason: check CI sooner$/);
		expect(results[3]).toBe('Timer "ci" cancelled.');
		expect(results[4]).toBe('No timer named "ci" in this session. No timer is armed.');
		const last = (h.requests[5] ?? []).filter((message) => message.role === "toolResult").at(-1);
		expect(last).toMatchObject({ isError: true });
		expect(timerStore().armed.size).toBe(0);
	});

	it("rejects invalid parameters as error results and arms nothing", async () => {
		const h = await start();
		h.respond([
			call("timer", { action: "set", delaySeconds: 0, reason: "x" }),
			call("timer", { action: "set", delaySeconds: 30 }),
			call("timer", { action: "snooze" }),
			say("done"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(4);

		const results = (h.requests[3] ?? []).filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.isError)).toEqual([true, true, true]);
		expect(toolTexts(h.requests[3])[1]).toContain("set requires a reason.");
		expect(timerStore().armed.size).toBe(0);
	});

	it("/timers lists and cancels with the same actions as the tool", async () => {
		const h = await start(true);
		h.respond([call("timer", { action: "set", name: "ci", delaySeconds: 60, reason: "check CI" }), say("set")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);

		await h.session.prompt("/timers");
		expect(h.uiNotices.at(-1)).toMatch(/^- ci: fires at \d\d:\d\d:\d\d \(in 60s\)\. Reason: check CI$/);
		await h.session.prompt("/timers cancel ci");
		expect(h.uiNotices.at(-1)).toBe('Timer "ci" cancelled.');
		await h.session.prompt("/timers cancel ci");
		expect(h.notifications.at(-1)).toEqual({
			message: 'No timer named "ci" in this session. No timer is armed.',
			level: "error",
		});
		expect(timerStore().armed.size).toBe(0);
	});

	it("can be called from inside another tool, as a codemode script does", async () => {
		const h = await start();
		h.respond([call("script_timer", {}), say("done")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);

		expect(toolTexts(h.requests[1])[0]).toContain('"isError":false');
		expect([...timerStore().armed.values()].map((timer) => timer.reason)).toEqual(["nested"]);
		expect(h.session.getAllTools().find((tool) => tool.name === "timer")?.exposure).toBe("direct");
	});
});

describe("timer delivery", () => {
	it("fires a wake with the reason through ctx.wake", async () => {
		const h = await start();
		h.respond([call("timer", { action: "set", name: "ci", delaySeconds: 600, reason: "check CI" }), say("set")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);

		h.respond([say("woke")]);
		await vi.advanceTimersByTimeAsync(600_000);
		await h.waitForRequests(3);

		expect(JSON.stringify(h.requests[2])).toContain('Timer \\"ci\\" fired (set 10m ago). Reason: check CI');
		expect(filtered.map((message) => message.customType)).toEqual(["timer"]);
		expect(filtered[0]?.details).toMatchObject({ name: "ci", reason: "check CI" });
		expect(h.requests).toHaveLength(3);
	});

	it.each([true, false])(
		"survives a reload and fires once into the new runtime (host bindings: %s)",
		async (bindings) => {
			const h = await start(false, bindings);
			h.respond([call("timer", { action: "set", name: "ci", delaySeconds: 60, reason: "after reload" }), say("set")]);
			await h.session.prompt("go");
			await h.waitForRequests(2);

			await h.session.reload();
			h.respond([say("woke"), say("must not be requested")]);
			await vi.advanceTimersByTimeAsync(60_000);
			await h.waitForRequests(3);
			await idle(h);

			const wakes = h.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "timer");
			expect(wakes).toHaveLength(1);
			expect(h.requests).toHaveLength(3);
			expect(h.extensionErrors).toEqual([]);
		},
	);

	it("drops the notice of the old runtime on every shutdown and keeps the session only on reload", async () => {
		const h = await start(true);
		const store = timerStore();
		const sessionId = h.session.sessionManager.getSessionId();
		expect(store.notice).toBeDefined();

		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		expect(store.notice).toBeUndefined();
		expect(store.wake).toBeUndefined();
		expect(store.sessionId).toBe(sessionId);

		await h.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		expect(store.notice).toBeUndefined();
		expect(store.sessionId).toBeUndefined();
	});

	it("shows a timer of another session as a notice and starts no run", async () => {
		const h = await start(true);
		setTimer(timerStore(), "other-session", { name: "theirs", delaySeconds: 5, reason: "their CI" }, Date.now());
		await vi.advanceTimersByTimeAsync(5_000);
		await idle(h);

		expect(h.uiNotices).toContain('Timer "theirs" of another session fired: their CI');
		expect(h.requests).toEqual([]);
	});

	it("clears every timer on quit", async () => {
		const h = await start();
		h.respond([call("timer", { action: "set", delaySeconds: 60, reason: "x" }), say("set")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);
		expect(timerStore().armed.size).toBe(1);

		await h.shutdown();
		expect(timerStore().armed.size).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.requests).toHaveLength(2);
	});
});

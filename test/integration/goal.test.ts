import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn } from "../../src/core/exec.ts";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState, reloadSlot } from "../../src/core/reload-state.ts";
import { background } from "../../src/features/background/index.ts";
import {
	cancelTimers,
	clearAllTimers,
	createTimerStore,
	type TimerStore,
} from "../../src/features/background/timers.ts";
import { createGoalFeature, type GoalStatePayload } from "../../src/features/goal/index.ts";
import { createGoal, type GoalRecord, latestFromEntries, pause } from "../../src/features/goal/state.ts";
import { createNotifyFeature } from "../../src/features/notify/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const define = (objective = "The feature is shipped.\nShown by: npm test exits 0.") =>
	call("goal_set", { action: "edit", objective });
const goalSet = (action: string, objective?: string) =>
	call("goal_set", objective === undefined ? { action } : { action, objective });
const GOAL_DONE_TEXT =
	"Goal done. Write the final message for the human now: what is true, the proof, and anything left undone. Do not call more tools.";
const NO_AUTHORITY =
	"Nothing changed: goal_set needs a human message in the current run. Continue the current work. If the goal should change, ask the human in your reply.";
const CHILD_TEXT =
	"Nothing changed: a child agent cannot set goals. Do the task you were given and report the result to your parent.";
const blockedAlone = call("notify", { kind: "blocked", message: "needs a decision" });
const setTimerCall = (reason: string, name?: string) =>
	call("timer", { action: "set", delaySeconds: 600, reason, ...(name ? { name } : {}) });
/** Arms a timer and ends the run, so an active goal settles. Two model requests. */
const park = (reason = "CI result", name?: string) => [setTimerCall(reason, name), say("waiting")];
const timerStore = () => reloadSlot<TimerStore>("background", "timers", 1, createTimerStore);
const armedNames = () => [...timerStore().armed.values()].map((timer) => timer.name);

function recordingExec(code = 0) {
	const calls: { command: string; args: string[]; cwd?: string | undefined }[] = [];
	const exec: ExecFn = async (command, args, options) => {
		calls.push({ command, args, cwd: options?.cwd });
		if (command === "kdeconnect-cli" && args[0] === "-a") return { code: 0, stdout: "", stderr: "" };
		return { code, stdout: "", stderr: code === 0 ? "" : "1 test failed" };
	};
	return { calls, exec };
}

const probeEvents: GoalStatePayload[] = [];
let probeWake: (customType: string, content: string) => void = () => {};
let probeUserMessage: (text: string) => void = () => {};
let probeInterrupt: () => void = () => {};
let slowStep = newSlowStep();
function newSlowStep() {
	let release: () => void = () => {};
	let started: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const running = new Promise<void>((resolve) => {
		started = resolve;
	});
	return { gate, release, running, started: () => started() };
}
const probe = defineFeature({
	id: "goal-probe",
	description: "test probe",
	defaultEnabled: true,
	setup(ctx) {
		ctx.events.on("goal:state", (payload) => probeEvents.push(payload as GoalStatePayload));
		probeWake = (customType, content) => ctx.wake({ customType, content, display: true });
		probeUserMessage = (text) => ctx.pi.sendUserMessage(text);
		probeInterrupt = () => ctx.events.emit("bus:interrupt", { from: "boss" });
		ctx.pi.registerTool({
			name: "nested_claim",
			label: "Nested claim",
			description: "test tool that claims the goal from inside a tool",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, toolCtx) {
				const outcome = await toolCtx.executeTool("goal_done", { evidence: "nested" });
				return { content: [{ type: "text", text: JSON.stringify({ isError: outcome.isError }) }], details: {} };
			},
		});
		ctx.pi.registerTool({
			name: "slow_step",
			label: "Slow step",
			description: "test tool that waits until the test releases it",
			parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				slowStep.started();
				await Promise.race([slowStep.gate, new Promise((resolve) => signal?.addEventListener("abort", resolve))]);
				const text = signal?.aborted ? "slow step aborted" : "OLD-GOAL-RESULT slow step done";
				return { content: [{ type: "text", text }], details: {} };
			},
		});
		ctx.pi.registerTool({
			name: "noop",
			label: "Noop",
			description: "test tool that does nothing",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "noop ran" }], details: {} };
			},
		});
	},
});

let harness: Harness | undefined;
let notifyCalls: ReturnType<typeof recordingExec>;
let checkCalls: ReturnType<typeof recordingExec>;

async function start(
	checkCode = 0,
	ui?: Partial<ExtensionUIContext>,
	goalOptions: { exec?: ExecFn } = {},
	harnessOptions: Partial<HarnessOptions> = {},
): Promise<Harness> {
	notifyCalls = recordingExec();
	checkCalls = recordingExec(checkCode);
	harness = await createHarness({
		features: [
			background,
			createNotifyFeature({ exec: notifyCalls.exec }),
			createGoalFeature({ exec: checkCalls.exec, ...goalOptions }),
			probe,
		],
		...(ui ? { ui } : {}),
		...harnessOptions,
	});
	return harness;
}

afterEach(() => {
	clearAllTimers(timerStore());
	harness?.dispose();
	harness = undefined;
	probeEvents.length = 0;
	slowStep = newSlowStep();
	clearReloadState();
});

const goalRecord = (h: Harness): GoalRecord | undefined => latestFromEntries(h.session.sessionManager.getBranch());
const isAdjudication = (messages: Message[]) => JSON.stringify(messages).includes("You are adjudicating");
const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));

async function settle(h: Harness, ms = 150) {
	await new Promise((resolve) => setTimeout(resolve, ms));
	await h.session.waitForIdle();
}

function expectPrefixChain(requests: Message[][]) {
	for (let index = 1; index < requests.length; index++) {
		const before = requests[index - 1] ?? [];
		expect(requests[index]?.slice(0, before.length)).toEqual(before);
	}
}

describe("goal in a session", () => {
	it("starts, continues at the settle boundary, and ends on goal_done with a final message", async () => {
		const h = await start();
		h.respond([
			define(),
			say("working on it"),
			call("goal_done", { evidence: "ran the tests" }),
			say("The feature is shipped. npm test exited 0."),
		]);
		await h.session.prompt("/goal ship the feature");
		await h.waitForRequests(4);
		await settle(h);

		const [first, , third, fourth] = h.requests;
		expect(JSON.stringify(first)).toContain("Goal set by the human.");
		expect(JSON.stringify(first)).toContain("ship the feature");
		expect(JSON.stringify(third)).toContain("Goal continuation 1.");
		expect(toolTexts(fourth).at(-1)).toBe(GOAL_DONE_TEXT);
		expect(goalRecord(h)).toMatchObject({ state: "achieved", detail: "ran the tests" });
		expect(h.requests).toHaveLength(4);
		expect(h.requests.some(isAdjudication)).toBe(false);
		expect(notifyCalls.calls.find((entry) => entry.command === "notify-send")?.args).toContain("pi goal: achieved");
		expect(probeEvents.at(-1)).toEqual({ state: "achieved", turns: expect.any(Number) as number });
		expect(probeEvents[0]).toEqual({});
		expect(probeEvents).toContainEqual({ state: "active", turns: 0 });
		expect(h.extensionErrors).toEqual([]);

		h.respond([say("you are welcome")]);
		await h.session.prompt("thanks");
		await settle(h);
		expect(h.requests).toHaveLength(5);
		expectPrefixChain(h.requests);
	});

	it("rejects claims through the check command and pauses at the rejection budget", async () => {
		const h = await start(1);
		h.respond([define("All tests pass."), ...park()]);
		await h.session.prompt("/goal all tests pass");
		await h.waitForRequests(3);
		await settle(h);
		expect(armedNames()).toEqual(["timer-1"]);

		await h.session.prompt("/goal-check npm test");
		expect(goalRecord(h)?.check).toBe("npm test");
		h.respond(Array.from({ length: 5 }, () => call("goal_done", { evidence: "ran npm test" })));
		await h.session.prompt("/goal resume");
		await h.waitForRequests(8);
		await settle(h);

		const record = goalRecord(h);
		expect(record).toMatchObject({ state: "paused", pauseReason: "rejected-claims", rejected: 5 });
		const checks = checkCalls.calls.filter((entry) => entry.command === "bash");
		expect(checks).toHaveLength(5);
		expect(checks[0]).toEqual({ command: "bash", args: ["-c", "npm test"], cwd: h.cwd });
		expect(toolTexts(h.requests[4]).at(-1)).toBe(
			"Check failed: exit 1:\n1 test failed\nKeep working: close that gap, then call goal_done again.",
		);
		expect(JSON.stringify(h.requests[3])).toContain("The goal check command changed.");
		expect(JSON.stringify(h.requests[3])).toContain("npm test");
		expect(h.requests).toHaveLength(8);
		expectPrefixChain(h.requests);
		const ping = notifyCalls.calls.find((entry) => entry.command === "notify-send");
		expect(ping?.args).toContain("pi goal: paused");
		expect(ping?.args.at(-1)).toMatch(/^rejected-claims\n/);
	});

	it("refuses goal_done called from inside another tool", async () => {
		const h = await start();
		h.respond([call("nested_claim", {}), ...park("build")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(3);
		await settle(h);
		expect(toolTexts(h.requests[1])).toContain(JSON.stringify({ isError: true }));
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("blocks notify kind=blocked with a sibling call without pausing, and alone it pauses and ends the run", async () => {
		const h = await start();
		h.respond([
			fauxAssistantMessage(
				[fauxToolCall("notify", { kind: "blocked", message: "needs a key" }), fauxToolCall("noop", {})],
				{ stopReason: "toolUse" },
			),
			blockedAlone,
			say("must not be requested"),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		const results = toolTexts(h.requests[1]).join("\n");
		expect(results).toContain('notify kind="blocked" must be the only tool call in its message');
		expect(results).toContain("noop ran");
		expect(h.requests).toHaveLength(2);
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "blocked", detail: "needs a decision" });
		const desktop = notifyCalls.calls.filter((entry) => entry.command === "notify-send");
		expect(desktop).toHaveLength(1);
		expect(desktop[0]?.args).toContain("pi: blocked, needs you");
	});

	it("keeps an active goal with an armed timer across reload and lets it wait once the process state is gone", async () => {
		const h = await start();
		h.respond(park("deploy"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		await h.session.reload();
		expect(goalRecord(h)?.state).toBe("active");
		expect(armedNames()).toEqual(["timer-1"]);

		clearAllTimers(timerStore());
		clearReloadState();
		await h.session.reload();
		expect(goalRecord(h)?.state).toBe("active");
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
		expect(goalEntries(h).some((record) => record.state === "paused")).toBe(false);
		expect(notifyCalls.calls).toEqual([]);
	});

	it("answers goal_done outside a goal with no side effects", async () => {
		const h = await start();
		h.respond([call("goal_done", { evidence: "y" }), say("ok")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);
		expect(toolTexts(h.requests[1])).toEqual(["No goal is active."]);
		expect(goalRecord(h)).toBeUndefined();
	});

	it("has no goal_wait tool", async () => {
		const h = await start();
		const names = h.session.getAllTools().map((tool) => tool.name);
		expect(names).toContain("goal_done");
		expect(names).toContain("timer");
		expect(names).not.toContain("goal_wait");
	});

	it("sets a goal from a long verb-like phrase and treats /goal check as goal text", async () => {
		const h = await start();
		h.respond([...park("a"), ...park("b")]);
		await h.session.prompt("/goal pause the server for maintenance");
		await h.waitForRequests(2);
		await settle(h);
		expect(goalRecord(h)?.condition).toBe("pause the server for maintenance");
		await h.session.prompt("/goal check npm test");
		await h.waitForRequests(4);
		await settle(h);
		expect(goalRecord(h)).toMatchObject({ condition: "check npm test", check: undefined });
	});
});

const goalEntries = (h: Harness) =>
	h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "goal")
		.map((entry) => (entry as { data: GoalRecord }).data);

describe("goal never interrupts the running step", () => {
	it("setting a goal during a slow tool call lets the tool finish and the start message lands after its result", async () => {
		const h = await start();
		h.respond([call("slow_step", {}), ...park("build")]);
		await h.session.prompt("/goal first goal");
		await slowStep.running;
		await h.session.prompt("/goal second goal");
		slowStep.release();
		await h.waitForRequests(3);
		await settle(h);

		const second = JSON.stringify(h.requests[1]);
		expect(second).toContain("OLD-GOAL-RESULT slow step done");
		expect(second).not.toContain("slow step aborted");
		expect(second.indexOf("OLD-GOAL-RESULT")).toBeLessThan(second.indexOf("second goal"));
		expect(goalEntries(h).some((record) => record.state === "paused")).toBe(false);
		expect(goalRecord(h)).toMatchObject({ condition: "second goal", state: "active" });
		expect(notifyCalls.calls).toEqual([]);
	});

	it("pause during a run does not abort it, and no continuation follows", async () => {
		const h = await start();
		h.respond([call("slow_step", {}), say("stopping here"), say("must not be requested")]);
		await h.session.prompt("/goal ship it");
		await slowStep.running;
		await h.session.prompt("/goal pause");
		slowStep.release();
		await h.waitForRequests(2);
		await settle(h);

		expect(toolTexts(h.requests[1])).toEqual(["OLD-GOAL-RESULT slow step done"]);
		expect(h.requests).toHaveLength(2);
		expect(JSON.stringify(h.requests)).not.toContain("Goal continuation");
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "user-input", detail: "you paused it" });
	});

	it("an aborted run leaves the goal active and waiting until the next human message", async () => {
		const h = await start(0, {});
		let streaming: () => void = () => {};
		const begun = new Promise<void>((resolve) => {
			streaming = resolve;
		});
		const cut: FauxResponseFactory = (_context, options) =>
			new Promise((resolve) => {
				streaming();
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "error" })));
			});
		h.respond([cut]);
		await h.session.prompt("/goal ship it");
		await begun;
		await h.session.abort();
		await settle(h);

		expect(goalRecord(h)?.state).toBe("active");
		expect(goalEntries(h).some((record) => record.state === "paused")).toBe(false);
		expect(h.uiNotices).toContain("Goal still active. It continues after your next message. /goal pause stops it.");
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
		expect(notifyCalls.calls).toEqual([]);

		h.respond([say("noted the job exit"), say("must not be requested")]);
		probeWake("background", "Background job build exited 0");
		await h.waitForRequests(2);
		await settle(h);
		expect(h.requests).toHaveLength(2);
		expect(goalRecord(h)?.state).toBe("active");

		h.respond([say("back on it"), ...park()]);
		await h.session.prompt("go on");
		await h.waitForRequests(5);
		await settle(h);
		expect(JSON.stringify(h.requests[3])).toContain("Goal continuation");
		expect(probeEvents.at(-1)).not.toHaveProperty("waiting");
		expect(goalRecord(h)?.state).toBe("active");
	});
});

describe("goal after an interrupted run", () => {
	const PEER_TEXT = "Goal waiting: a peer interrupted the run. It continues after your next message.";

	async function interrupted(h: Harness, beforeAbort = () => {}, prompt = "/goal ship it") {
		let streaming: () => void = () => {};
		const begun = new Promise<void>((resolve) => {
			streaming = resolve;
		});
		const cut: FauxResponseFactory = (_context, options) =>
			new Promise((resolve) => {
				streaming();
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "error" })));
			});
		h.respond([cut]);
		await h.session.prompt(prompt);
		await begun;
		beforeAbort();
		await h.session.abort();
		await settle(h);
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
	}

	it("/goal pause and /goal resume after Esc continue the goal and end the wait", async () => {
		const h = await start(0, {});
		await interrupted(h);
		await h.session.prompt("/goal pause");
		expect(probeEvents.at(-1)).not.toHaveProperty("waiting");

		h.respond([say("resumed work"), ...park()]);
		await h.session.prompt("/goal resume");
		await h.waitForRequests(4);
		await settle(h);
		expect(JSON.stringify(h.requests[2])).toContain("Goal continuation");
		expect(probeEvents.at(-1)).toMatchObject({ state: "active" });
		expect(probeEvents.at(-1)).not.toHaveProperty("waiting");
	});

	it("an interrupt from a bus peer also sends a phone info, and Esc does not", async () => {
		const h = await start(0, {});
		await interrupted(h, probeInterrupt);
		expect(h.uiNotices).toContain(PEER_TEXT);
		const desktop = notifyCalls.calls.filter((entry) => entry.command === "notify-send").map((entry) => entry.args);
		expect(desktop).toHaveLength(1);
		expect(desktop[0]?.at(-1)).toBe(PEER_TEXT);
		expect(h.uiNotices).not.toContain("Goal still active. It continues after your next message. /goal pause stops it.");

		await h.session.prompt("/goal pause");
		await interrupted(h, () => {}, "/goal resume");
		expect(h.uiNotices).toContain("Goal still active. It continues after your next message. /goal pause stops it.");
		expect(notifyCalls.calls.filter((entry) => entry.command === "notify-send")).toHaveLength(1);
	});

	it("/goal resume during a run that does not end the wait continues the goal after that run", async () => {
		const h = await start(0, {});
		await interrupted(h);
		h.respond([call("slow_step", {}), say("job noted"), say("back on the goal"), ...park()]);
		probeWake("background", "Background job build exited 0");
		await slowStep.running;
		await h.session.prompt("/goal resume");
		expect(h.uiNotices).toContain("The goal continues after this run.");
		slowStep.release();
		await h.waitForRequests(5);
		await settle(h);
		expect(JSON.stringify(h.requests[3])).toContain("Goal continuation");
		expect(probeEvents.at(-1)).not.toHaveProperty("waiting");
	});

	it("does not warn about a missing timer while the goal waits", async () => {
		const h = await start(0, {});
		let streaming: () => void = () => {};
		const begun = new Promise<void>((resolve) => {
			streaming = resolve;
		});
		const cut: FauxResponseFactory = (_context, options) =>
			new Promise((resolve) => {
				streaming();
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "error" })));
			});
		h.respond([setTimerCall("CI", "ci"), cut]);
		await h.session.prompt("/goal ship it");
		await begun;
		await h.session.abort();
		await settle(h);
		await h.session.prompt("/timers cancel ci");
		expect(armedNames()).toEqual([]);
		expect(h.uiNotices).not.toContain("The active goal has no armed timer. Run /goal resume to continue it.");
	});
});

describe("goal replacement and typo guard", () => {
	it("replacing a goal in a UI session asks for confirmation, and No keeps the old goal", async () => {
		const asked: [string, string][] = [];
		const h = await start(0, {
			confirm: async (title, message) => {
				asked.push([title, message]);
				return false;
			},
		});
		h.respond(park("build"));
		await h.session.prompt("/goal first goal");
		await h.waitForRequests(2);
		await settle(h);
		const before = goalRecord(h);

		await h.session.prompt("/goal second goal");
		expect(asked).toEqual([["Replace the current goal?", "Current: first goal\n\nNew: second goal"]]);
		expect(goalRecord(h)).toEqual(before);
		expect(h.requests).toHaveLength(2);
		expect(armedNames()).toEqual(["timer-1"]);
	});

	it("/goal l resume with a paused goal asks the typo question, and No keeps the paused goal unchanged", async () => {
		const asked: string[] = [];
		const h = await start(0, {
			confirm: async (title) => {
				asked.push(title);
				return false;
			},
		});
		h.respond(park("build"));
		await h.session.prompt("/goal first line\nsecond line\nthird line\nfourth line");
		await h.waitForRequests(2);
		await settle(h);
		await h.session.prompt("/goal pause");
		const paused = goalRecord(h);
		expect(paused?.state).toBe("paused");

		await h.session.prompt("/goal l resume");
		expect(asked).toEqual(["Set this as the goal?"]);
		expect(goalRecord(h)).toEqual(paused);
	});

	it("/goal l resume without UI refuses and keeps the goal", async () => {
		const h = await start();
		h.respond(park("build"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);
		await h.session.prompt("/goal pause");
		const paused = goalRecord(h);

		await h.session.prompt("/goal l resume");
		expect(goalRecord(h)).toEqual(paused);
		expect(h.requests).toHaveLength(2);
	});
});

describe("check limits", () => {
	it("bounds a check by its own timeout and accepts on exit 0", async () => {
		const seen: { timeoutMs?: number | undefined; abortedAtEnd?: boolean }[] = [];
		const slowCheck: ExecFn = async (_command, _args, options) => {
			const entry: (typeof seen)[number] = { timeoutMs: options?.timeoutMs };
			seen.push(entry);
			await new Promise((resolve) => setTimeout(resolve, 200));
			entry.abortedAtEnd = options?.signal?.aborted ?? true;
			return { code: 0, stdout: "", stderr: "" };
		};
		const h = await start(0, undefined, { exec: slowCheck });
		h.respond([define(), ...park("build")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(3);
		await settle(h);
		await h.session.prompt("/goal-check npm test");
		h.respond([call("goal_done", { evidence: "ran it" }), say("shipped")]);
		await h.session.prompt("/goal resume");
		await h.waitForRequests(5);
		await settle(h);
		expect(toolTexts(h.requests[4]).at(-1)).toBe(`Check passed: npm test exited 0. ${GOAL_DONE_TEXT}`);

		expect(seen).toEqual([{ timeoutMs: 15 * 60_000, abortedAtEnd: false }]);
		expect(goalRecord(h)?.state).toBe("achieved");
	});

	it("writes no verdict when the session reloads during a check", async () => {
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hangingCheck: ExecFn = (_command, _args, options) =>
			new Promise((resolve) => {
				started();
				options?.signal?.addEventListener("abort", () =>
					resolve({ code: -1, stdout: "", stderr: "cancelled", failed: "aborted" }),
				);
			});
		const h = await start(0, undefined, { exec: hangingCheck });
		h.respond([define(), ...park("build")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(3);
		await settle(h);
		await h.session.prompt("/goal-check npm test");
		h.respond([call("goal_done", { evidence: "ran it" }), say("after")]);
		await h.session.prompt("/goal resume");
		await running;
		await h.session.reload();
		await settle(h);

		expect(goalEntries(h).some((record) => record.pauseReason === "unverified")).toBe(false);
		expect(notifyCalls.calls.some((entry) => entry.args.includes("pi goal: paused"))).toBe(false);
		expect(h.extensionErrors).toEqual([]);
	});
});

describe("goal waits on timers", () => {
	it("settles while a timer is armed and continues while none is armed", async () => {
		const h = await start();
		h.respond([say("thinking"), ...park("CI result")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(3);
		await settle(h);

		expect(JSON.stringify(h.requests[1])).toContain("Goal continuation");
		expect(h.requests).toHaveLength(3);
		expect(goalRecord(h)?.state).toBe("active");
		expect(armedNames()).toEqual(["timer-1"]);
		const due = timerStore().armed.values().next().value?.dueAt;
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", timerDueAt: due });
	});

	it("a background wake neither cancels nor consumes the timer", async () => {
		const h = await start();
		h.respond(park("deploy"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		h.respond([say("noted the job exit"), say("must not be requested")]);
		probeWake("background", "Background job build exited 0");
		await h.waitForRequests(3);
		await settle(h);

		expect(JSON.stringify(h.requests[2])).toContain("Background job build exited 0");
		expect(h.requests).toHaveLength(3);
		expect(armedNames()).toEqual(["timer-1"]);
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("pauses as stalled after 3 runs in a row without a tool call and without a timer", async () => {
		const h = await start();
		h.respond([say("one"), say("two"), say("three"), say("must not be requested")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(3);
		await settle(h);

		expect(h.requests).toHaveLength(3);
		expect(goalRecord(h)).toMatchObject({
			state: "paused",
			pauseReason: "stalled",
			detail: "The agent ended 3 runs in a row without work and without a timer.",
		});
	});

	it("a tool call resets the stall count", async () => {
		const h = await start();
		h.respond([
			say("one"),
			say("two"),
			call("noop", {}),
			say("after the tool"),
			say("four"),
			say("five"),
			say("six"),
			say("must not be requested"),
		]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(7);
		await settle(h);

		expect(h.requests).toHaveLength(7);
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "stalled" });
	});

	async function goalWithOldTimer(h: Harness) {
		h.respond([setTimerCall("before the goal", "old"), say("set")]);
		await h.session.prompt("set a timer");
		await h.waitForRequests(2);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	it.each([
		["pause", "/goal pause", "paused"],
		["clear", "/goal clear", "cleared"],
	])("%s cancels the timers set since the goal started and keeps an older one", async (_name, command, state) => {
		const h = await start();
		await goalWithOldTimer(h);
		h.respond(park("goal work", "goal"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(4);
		await settle(h);
		expect(armedNames()).toEqual(["old", "goal"]);

		await h.session.prompt(command);
		expect(goalRecord(h)?.state).toBe(state);
		expect(armedNames()).toEqual(["old"]);
	});

	it("an accepted claim cancels the goal's timers and keeps an older one", async () => {
		const h = await start();
		await goalWithOldTimer(h);
		h.respond([define(), setTimerCall("goal work", "goal"), call("goal_done", { evidence: "done" }), say("done")]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(6);
		await settle(h);

		expect(goalRecord(h)?.state).toBe("achieved");
		expect(armedNames()).toEqual(["old"]);
	});

	it("a replaced goal takes its timers along and keeps an older one", async () => {
		const h = await start();
		await goalWithOldTimer(h);
		h.respond(park("first goal work", "first"));
		await h.session.prompt("/goal first goal");
		await h.waitForRequests(4);
		await settle(h);

		h.respond(park("second goal work", "second"));
		await h.session.prompt("/goal second goal");
		await h.waitForRequests(6);
		await settle(h);

		expect(goalRecord(h)).toMatchObject({ condition: "second goal", state: "active" });
		expect(armedNames()).toEqual(["old", "second"]);
	});

	it("/goal resume on an active idle goal fires its timer at once", async () => {
		const h = await start();
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		h.respond(park("CI again", "ci"));
		await h.session.prompt("/goal resume");
		await h.waitForRequests(4);
		await settle(h);

		expect(JSON.stringify(h.requests[2])).toContain('Timer \\"ci\\" fired');
		expect(JSON.stringify(h.requests[2])).toContain("Reason: CI result");
		expect(h.requests).toHaveLength(4);
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("loads and renders a goal saved with a waiting field", async () => {
		const h = await start(0, { confirm: async () => true });
		h.respond(park());
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);
		const saved = goalRecord(h);
		if (!saved) throw new Error("no goal");
		h.session.sessionManager.appendCustomEntry("goal", {
			...saved,
			waiting: { token: "w1", reason: "CI result", generation: saved.generation },
		});

		await h.session.reload();
		expect(goalRecord(h)?.state).toBe("active");
		await h.session.prompt("/goal");
		expect(h.uiNotices.at(-1)).toMatch(
			/^Goal \(active, set by the human\)\nobjective: not defined yet\nrequest: ship it\n/,
		);
		expect(h.uiNotices.at(-1)).not.toContain("waiting");
	});
});

describe("goal and timer changes", () => {
	const confirmYes = { confirm: async () => true };
	const IDLE_WARNING = "The active goal has no armed timer. Run /goal resume to continue it.";

	it("keeps the goal active when its timer fired during the reload and delivers that timer after it", async () => {
		const h = await start();
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		const store = timerStore();
		const fired = [...store.armed.values()].map(({ handle: _handle, ...info }) => info);
		cancelTimers(store, { sessionId: h.session.sessionManager.getSessionId() });
		store.queue.push(...fired);

		h.respond(park("CI again", "ci"));
		await h.session.reload();
		await h.waitForRequests(4);
		await settle(h);

		expect(JSON.stringify(h.requests[2])).toContain('Timer \\"ci\\" fired');
		expect(goalRecord(h)?.state).toBe("active");
		expect(goalEntries(h).some((record) => record.pauseReason === "wake-source-lost")).toBe(false);
	});

	it("/goal resume on an active idle goal without a goal timer sends the continuation", async () => {
		const h = await start(0, confirmYes);
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);
		await h.session.prompt("/timers cancel ci");

		h.respond(park("CI again", "ci"));
		await h.session.prompt("/goal resume");
		await h.waitForRequests(4);
		await settle(h);

		expect(JSON.stringify(h.requests[2])).toContain("Goal continuation");
		expect(JSON.stringify(h.requests[2])).not.toContain("fired");
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("publishes a fresh timerDueAt and warns once when the last goal timer is cancelled while idle", async () => {
		const h = await start(0, confirmYes);
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);
		const due = timerStore().armed.values().next().value?.dueAt;
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", timerDueAt: due });
		expect(h.uiNotices).not.toContain(IDLE_WARNING);

		await h.session.prompt("/timers cancel ci");
		expect(probeEvents.at(-1)).toEqual({ state: "active", turns: expect.any(Number) as number });
		expect(h.uiNotices.filter((text) => text === IDLE_WARNING)).toHaveLength(1);
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("does not warn when a goal timer fires, when a timer outlives its goal, or when a goal is replaced", async () => {
		const h = await start(0, confirmYes);
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		h.respond(park("CI again", "ci"));
		await h.session.prompt("/goal resume");
		await h.waitForRequests(4);
		await settle(h);

		h.respond(park("second goal", "second"));
		await h.session.prompt("/goal another goal");
		await h.waitForRequests(6);
		await settle(h);
		await h.session.prompt("/goal pause");

		expect(h.uiNotices).not.toContain(IDLE_WARNING);
	});

	it("/goal lists the goal's armed timers", async () => {
		const h = await start(0, confirmYes);
		h.respond(park("CI result", "ci"));
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		await h.session.prompt("/goal");
		expect(h.uiNotices.at(-1)).toMatch(/\ntimer ci: fires at \d\d:\d\d:\d\d\. Reason: CI result$/);
	});
});

describe("goals the model sets", () => {
	const OBJECTIVE = "v1 is tagged.\nShown by: git tag lists v1.";
	const REQUEST = "keep going until v1 is tagged, i'll be afk";
	const create = (objective = OBJECTIVE) => goalSet("create", objective);
	const noAuthorityCount = (h: Harness) => toolTexts(h.requests.at(-1)).filter((text) => text === NO_AUTHORITY).length;

	it("creates a goal from a human message, continues it, and ends with a final message", async () => {
		const h = await start(0, {});
		h.respond([
			create(),
			say("working"),
			call("goal_done", { evidence: "git tag printed v1" }),
			say("v1 is tagged. git tag printed v1."),
		]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(4);
		await settle(h);

		expect(toolTexts(h.requests[1])).toEqual([
			"Goal created and active. Keep working toward it. Each run end gets a continuation until goal_done or a blocker.",
		]);
		expect(JSON.stringify(h.requests[2])).toContain("Goal continuation");
		expect(toolTexts(h.requests[3]).at(-1)).toBe(GOAL_DONE_TEXT);
		expect(h.requests).toHaveLength(4);
		expect(goalRecord(h)).toMatchObject({
			state: "achieved",
			setBy: "model",
			condition: REQUEST,
			objective: OBJECTIVE,
			detail: "git tag printed v1",
		});
		expect(h.uiNotices).toContain(`Goal set by the model: ${OBJECTIVE}\nUndo with /goal clear.`);
		expect(h.uiNotices).toContain("Goal done: git tag printed v1");
		const desktop = notifyCalls.calls.filter((entry) => entry.command === "notify-send").map((entry) => entry.args);
		expect(desktop.map((args) => args.includes("pi goal: set by the model"))).toEqual([true, false]);
		expect(desktop[0]?.at(-1)).toBe(OBJECTIVE);
		expect(desktop[1]).toContain("pi goal: achieved");
		expect(desktop[1]?.at(-1)).toBe("git tag printed v1");
	});

	it("refuses goal_set in a continuation, a bus wake, a timer wake, and a message sent by an extension", async () => {
		const h = await start();
		h.respond([create(), say("working"), goalSet("edit", "narrower"), ...park("ci", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(5);
		await settle(h);
		expect(noAuthorityCount(h)).toBe(1);

		h.respond([goalSet("pause"), say("noted")]);
		probeWake("bus", "peer says hi");
		await h.waitForRequests(7);
		await settle(h);
		expect(noAuthorityCount(h)).toBe(2);

		h.respond([goalSet("clear"), ...park("ci again", "ci")]);
		await h.session.prompt("/goal resume");
		await h.waitForRequests(10);
		await settle(h);
		expect(JSON.stringify(h.requests[7])).toContain('Timer \\"ci\\" fired');
		expect(noAuthorityCount(h)).toBe(3);

		h.respond([goalSet("edit", "narrower"), say("ok")]);
		probeUserMessage("extension words");
		await h.waitForRequests(12);
		await settle(h);
		expect(noAuthorityCount(h)).toBe(4);
		expect(goalRecord(h)).toMatchObject({ state: "active", objective: OBJECTIVE });
		expect(goalRecord(h)?.changes).toBeUndefined();
	});

	it("edits the objective on a human steer during a goal run and keeps timers and the goal id", async () => {
		const h = await start(0, {});
		const steer = "actually skip the deploy, just tag it";
		const newer = "v1 is tagged. Not deployed.\nShown by: git tag lists v1.";
		h.respond([create(), setTimerCall("CI", "ci"), call("slow_step", {}), goalSet("edit", newer), say("ok")]);
		const run = h.session.prompt(REQUEST);
		await slowStep.running;
		const before = goalRecord(h);
		await h.session.steer(steer);
		slowStep.release();
		await run;
		await h.waitForRequests(5);
		await settle(h);

		const result = toolTexts(h.requests[4]).at(-1) ?? "";
		expect(result).toMatch(
			/^Objective replaced\. It is the goal from now on\. The earlier objective no longer counts\.\n<active-goal>\n/,
		);
		expect(result).toContain(
			`objective:\n${newer}\nhuman request:\n${REQUEST}\nhuman changes, oldest first:\n- ${steer}\n`,
		);
		expect(goalRecord(h)).toMatchObject({ id: before?.id, objective: newer, changes: [{ request: steer }] });
		expect(armedNames()).toEqual(["ci"]);
		expect(h.uiNotices).toContain(
			`Goal changed at your request: v1 is tagged. Not deployed.\nwas: v1 is tagged.\nyou said: ${steer}\nFull text: /goal`,
		);
		expect(notifyCalls.calls.filter((entry) => entry.command === "notify-send")).toHaveLength(1);
	});

	it("edits on a human follow-up, and the next continuation cannot edit", async () => {
		const h = await start();
		h.respond([
			create(),
			call("slow_step", {}),
			say("step done"),
			goalSet("edit", "v1 and v1.0.1 are tagged."),
			say("working"),
			goalSet("edit", "v1 is tagged locally."),
			...park(),
		]);
		const run = h.session.prompt(REQUEST);
		await slowStep.running;
		await h.session.followUp("also tag v1.0.1");
		slowStep.release();
		await run;
		await h.waitForRequests(8);
		await settle(h);

		const texts = toolTexts(h.requests.at(-1));
		expect(texts.filter((text) => text.startsWith("Objective replaced."))).toHaveLength(1);
		expect(noAuthorityCount(h)).toBe(1);
		expect(goalRecord(h)).toMatchObject({
			objective: "v1 and v1.0.1 are tagged.",
			changes: [{ request: "also tag v1.0.1" }],
		});
	});

	it("refuses an edit with the same objective and changes nothing", async () => {
		const h = await start();
		h.respond([create(), ...park()]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);
		const before = goalRecord(h);

		h.respond([goalSet("edit", OBJECTIVE), say("same")]);
		await h.session.prompt("keep the same goal");
		await h.waitForRequests(5);
		await settle(h);
		expect(toolTexts(h.requests[4]).at(-1)).toBe("Nothing changed: the new objective is the same as the current one.");
		expect(goalRecord(h)).toEqual(before);
	});

	it("refuses create while a goal is active or paused", async () => {
		const h = await start();
		h.respond([create(), ...park()]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);

		h.respond([create("another"), say("no")]);
		await h.session.prompt("keep going until v2 is tagged");
		await h.waitForRequests(5);
		await settle(h);
		expect(toolTexts(h.requests[4]).at(-1)).toBe(
			'Nothing changed: a goal is already active. Use action="edit" if the human asked to change it.',
		);

		await h.session.prompt("/goal pause");
		h.respond([create("another"), say("no")]);
		await h.session.prompt("keep going until v2 is tagged");
		await h.waitForRequests(7);
		await settle(h);
		expect(toolTexts(h.requests[6]).at(-1)).toBe(
			'Nothing changed: a paused goal exists. Use action="edit" if the human asked to change it. Else ask the human to run /goal resume or /goal clear.',
		);
		expect(goalRecord(h)).toMatchObject({ state: "paused", objective: OBJECTIVE });
	});

	it("pauses, resumes, and clears the goal on human request", async () => {
		const h = await start(0, {});
		h.respond([create(), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);

		h.respond([goalSet("pause"), say("paused")]);
		await h.session.prompt("pause the goal for now");
		await h.waitForRequests(5);
		await settle(h);
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "user-input" });
		expect(armedNames()).toEqual([]);
		expect(h.uiNotices).toContain("Goal paused at your request. Resume: say so, or /goal resume.");

		h.respond([goalSet("resume"), ...park()]);
		await h.session.prompt("continue the goal");
		await h.waitForRequests(8);
		await settle(h);
		expect(goalRecord(h)?.state).toBe("active");
		expect(h.uiNotices).toContain("Goal resumed at your request.");
		expect(toolTexts(h.requests[6]).at(-1)).toMatch(/^Goal resumed\. .*\n<active-goal>\nobjective:\nv1 is tagged\./);

		h.respond([goalSet("clear"), say("cleared")]);
		await h.session.prompt("drop the goal, we are done with it");
		await h.waitForRequests(10);
		await settle(h);
		expect(goalRecord(h)?.state).toBe("cleared");
		expect(h.uiNotices).toContain(`Goal cleared at your request: ${OBJECTIVE}`);
		expect(h.requests).toHaveLength(10);
	});

	it("reminds the model of the edited objective and the change after a compaction", async () => {
		const h = await start(0, {});
		const steer = "only tag it, no deploy";
		const newer = "v1 is tagged. Not deployed.";
		// Compaction needs older history than the recent window it keeps.
		const filler = "x".repeat(100_000);
		h.respond([create(), ...park("CI", "ci")]);
		await h.session.prompt(`${REQUEST} ${filler}`);
		await h.waitForRequests(3);
		await settle(h);
		h.respond([goalSet("edit", newer), say("edited")]);
		await h.session.prompt(`${steer} ${filler}`);
		await h.waitForRequests(5);
		await settle(h);

		h.respond([say("SUMMARY"), say("SUMMARY")]);
		await h.session.compact();
		await settle(h);
		const reminder = h.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal-condition")
			.map((entry) => String((entry as { content?: unknown }).content))
			.at(-1);
		expect(reminder).toContain(`The active goal continues after compaction.\n<active-goal>\nobjective:\n${newer}\n`);
		expect(reminder).toContain(`human changes, oldest first:\n- ${steer} xxx`);
	});

	it("numbers continuations 1, 2 and keeps that number and the turn count across a reload", async () => {
		const h = await start(0, {});
		h.respond([create(), say("first step"), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(4);
		await settle(h);
		expect(JSON.stringify(h.requests[2])).toContain("Goal continuation 1.");
		const turns = probeEvents.at(-1)?.turns ?? 0;
		expect(turns).toBeGreaterThan(0);

		clearAllTimers(timerStore());
		await h.session.reload();
		await settle(h);
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", turns, waiting: true });

		h.respond([say("back"), ...park()]);
		await h.session.prompt("go on");
		await h.waitForRequests(7);
		await settle(h);
		expect(JSON.stringify(h.requests[5])).toContain("Goal continuation 2.");
	});

	it("lets the model define the objective of a /goal goal once without a human message", async () => {
		const h = await start(0, {});
		h.respond([
			call("goal_done", { evidence: "nothing yet" }),
			define(OBJECTIVE),
			say("working"),
			goalSet("edit", "something else"),
			...park(),
		]);
		await h.session.prompt("/goal continue the work until it is tagged");
		await h.waitForRequests(6);
		await settle(h);

		expect(JSON.stringify(h.requests[0])).toContain('First call goal_set action=\\"edit\\"');
		expect(toolTexts(h.requests[1])).toEqual([
			'Nothing changed: the goal has no objective yet. Call goal_set action="edit" first.',
		]);
		expect(toolTexts(h.requests[2]).at(-1)).toBe(
			"Objective saved. Keep working toward it. Call goal_done when it holds now.",
		);
		expect(noAuthorityCount(h)).toBe(1);
		expect(goalRecord(h)).toMatchObject({
			state: "active",
			setBy: "human",
			condition: "continue the work until it is tagged",
			objective: OBJECTIVE,
		});
		expect(goalRecord(h)?.changes).toBeUndefined();
		expect(h.uiNotices).toContain(`Goal objective: ${OBJECTIVE}`);
	});

	it("saves the human text as the objective of a /goal goal when goal_set is off", async () => {
		const h = await start(
			0,
			undefined,
			{},
			{
				setupAgentDir: (agentDir) =>
					writeFileSync(join(agentDir, "pimon.json"), JSON.stringify({ tools: { goal_set: false } })),
			},
		);
		h.respond(park());
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h);

		expect(JSON.stringify(h.requests[0])).not.toContain("goal_set");
		expect(JSON.stringify(h.requests[0])).toContain("objective:\\nship it");
		expect(goalRecord(h)).toMatchObject({ setBy: "human", objective: "ship it", condition: "ship it" });
	});

	it("refuses goal_set in a child agent, except the first objective of a /goal goal", async () => {
		const h = await start();
		h.session.sessionManager.appendCustomEntry("pimon-spawn", { id: "s1" });
		h.respond([create(), say("ok")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(2);
		await settle(h);
		expect(toolTexts(h.requests[1])).toEqual([CHILD_TEXT]);
		expect(goalRecord(h)).toBeUndefined();

		h.respond([define(OBJECTIVE), goalSet("pause"), ...park()]);
		await h.session.prompt("/goal tag v1");
		await h.waitForRequests(6);
		await settle(h);
		expect(toolTexts(h.requests[3])).toContain(CHILD_TEXT);
		expect(goalRecord(h)).toMatchObject({ state: "active", objective: OBJECTIVE });
	});
});

describe("goal after reload and restart", () => {
	const WAITING_NOTICE = "Goal still active. It continues after your next message. /goal pause stops it.";
	const REQUEST = "keep going until v1 is tagged, i'll be afk";
	const OBJECTIVE = "v1 is tagged.";

	it("a reload of an active goal without a timer makes it wait, with no pause and no notice", async () => {
		const h = await start(0, {});
		h.respond([goalSet("create", OBJECTIVE), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);
		clearAllTimers(timerStore());

		await h.session.reload();
		await settle(h);
		expect(h.requests).toHaveLength(3);
		expect(goalRecord(h)?.state).toBe("active");
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
		expect(h.uiNotices.filter((text) => text.startsWith("Goal paused") || text === WAITING_NOTICE)).toEqual([]);

		h.respond([say("back"), goalSet("edit", "narrower"), ...park()]);
		await h.session.prompt("go on");
		await h.waitForRequests(7);
		await settle(h);
		expect(JSON.stringify(h.requests[4])).toContain("Goal continuation");
		expect(toolTexts(h.requests[5]).at(-1)).toBe(NO_AUTHORITY);
		expect(goalRecord(h)).toMatchObject({ state: "active", objective: OBJECTIVE });
	});

	it("a goal that waits after Esc still waits after a reload, also with an armed timer", async () => {
		const h = await start(0, {});
		let streaming: () => void = () => {};
		const begun = new Promise<void>((resolve) => {
			streaming = resolve;
		});
		const cut: FauxResponseFactory = (_context, options) =>
			new Promise((resolve) => {
				streaming();
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "error" })));
			});
		h.respond([goalSet("create", OBJECTIVE), setTimerCall("CI", "ci"), cut]);
		const run = h.session.prompt(REQUEST);
		await begun;
		await h.session.abort();
		await run;
		await settle(h);
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });

		await h.session.reload();
		await settle(h);
		expect(armedNames()).toEqual(["ci"]);
		expect(goalRecord(h)?.state).toBe("active");
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
	});

	it("a reload of an active goal with an armed timer keeps it running, and a fired goal timer continues it", async () => {
		const h = await start(0, {});
		h.respond([goalSet("create", OBJECTIVE), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);

		await h.session.reload();
		expect(probeEvents.at(-1)).not.toHaveProperty("waiting");
		h.respond([say("CI is still running"), ...park("CI again", "ci")]);
		await h.session.prompt("/goal resume");
		await h.waitForRequests(6);
		await settle(h);
		expect(JSON.stringify(h.requests[3])).toContain('Timer \\"ci\\" fired');
		expect(JSON.stringify(h.requests[4])).toContain("Goal continuation");
		expect(goalRecord(h)?.state).toBe("active");
	});

	it("a restart into a session with an active goal makes it wait, with one notice", async () => {
		const saved = createGoal({ condition: REQUEST, objective: OBJECTIVE, setBy: "model", now: Date.now(), id: "g1" });
		const h = await start(
			0,
			{},
			{},
			{
				sessionManager: (cwd) => {
					const manager = SessionManager.inMemory(cwd);
					manager.appendCustomEntry("goal", saved);
					return manager;
				},
			},
		);
		await settle(h);
		expect(goalRecord(h)).toEqual(saved);
		expect(h.uiNotices.filter((text) => text === WAITING_NOTICE)).toHaveLength(1);
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
		expect(h.requests).toHaveLength(0);
		expect(notifyCalls.calls).toEqual([]);
	});

	function savedSession(record: GoalRecord): { dir: string; file: string } {
		const dir = mkdtempSync(join(tmpdir(), "goal-fork-"));
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendMessage({ role: "user", content: REQUEST, timestamp: Date.now() });
		manager.appendCustomEntry("goal", record);
		manager.appendMessage(say("working"));
		const file = manager.getSessionFile();
		if (!file || !existsSync(file)) throw new Error("the source session was not saved");
		return { dir, file };
	}
	const FORK_DETAIL = "This session is a fork; the goal belongs to the original session.";
	const activeGoal = () =>
		createGoal({ condition: REQUEST, objective: OBJECTIVE, setBy: "model", now: Date.now() - 1000, id: "g1" });

	it("a session forked from a file pauses the copied goal at startup", async () => {
		const source = savedSession(activeGoal());
		await new Promise((resolve) => setTimeout(resolve, 5));
		const h = await start(
			0,
			{},
			{},
			{
				sessionManager: (cwd) => SessionManager.forkFrom(source.file, cwd, join(source.dir, "sessions")),
			},
		);
		await settle(h);
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "fork", detail: FORK_DETAIL });
		expect(h.uiNotices).not.toContain(WAITING_NOTICE);
		expect(notifyCalls.calls).toEqual([]);
	});

	it("a branched child session pauses the copied goal at startup", async () => {
		const source = savedSession(activeGoal());
		await new Promise((resolve) => setTimeout(resolve, 5));
		const clone = SessionManager.open(source.file);
		const leaf = clone.getLeafId();
		if (!leaf) throw new Error("no leaf");
		const branched = clone.createBranchedSession(leaf);
		if (!branched) throw new Error("no branched session");
		if (!existsSync(branched)) {
			const header = clone.getHeader();
			writeFileSync(branched, `${[header, ...clone.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		}
		const h = await start(0, {}, {}, { sessionManager: () => SessionManager.open(branched) });
		await settle(h);
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "fork", detail: FORK_DETAIL });
	});

	it("a restart of the same saved session keeps the goal active and waiting", async () => {
		const source = savedSession(activeGoal());
		await new Promise((resolve) => setTimeout(resolve, 5));
		const h = await start(0, {}, {}, { sessionManager: () => SessionManager.open(source.file) });
		await settle(h);
		expect(goalRecord(h)?.state).toBe("active");
		expect(h.uiNotices.filter((text) => text === WAITING_NOTICE)).toHaveLength(1);
		expect(probeEvents.at(-1)).toMatchObject({ state: "active", waiting: true });
	});

	it("a fork pauses the goal and says that it belongs to the original session", async () => {
		const h = await start(0, {});
		h.respond([goalSet("create", OBJECTIVE), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);

		await h.session.extensionRunner.emit({ type: "session_start", reason: "fork" });
		expect(goalRecord(h)).toMatchObject({
			state: "paused",
			pauseReason: "fork",
			detail: "This session is a fork; the goal belongs to the original session.",
		});
		expect(notifyCalls.calls.filter((entry) => entry.args.includes("pi goal: paused"))).toEqual([]);
	});

	it("branch navigation pauses the goal as navigation", async () => {
		const h = await start(0, {});
		h.respond([goalSet("create", OBJECTIVE), ...park("CI", "ci")]);
		await h.session.prompt(REQUEST);
		await h.waitForRequests(3);
		await settle(h);

		await h.session.extensionRunner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "navigation" });
	});

	it("loads and renders a record with a waiting field and a wake-source-lost pause", async () => {
		const h = await start(0, {});
		const old = pause(
			createGoal({ condition: "ship it", now: Date.now(), id: "g-old" }),
			"wake-source-lost",
			"No timer is armed in this pi process.",
			Date.now(),
		);
		h.session.sessionManager.appendCustomEntry("goal", {
			...old,
			waiting: { token: "w1", reason: "CI", generation: 1 },
		});
		await h.session.reload();
		await h.session.prompt("/goal");
		expect(h.uiNotices.at(-1)).toContain("Goal (paused)\nobjective: ship it\n");
		expect(h.uiNotices.at(-1)).toContain("paused: wake-source-lost (No timer is armed in this pi process.)");
		expect(goalRecord(h)).toEqual(old);
	});
});

import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn } from "../../src/core/exec.ts";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createGoalFeature, type GoalStatePayload } from "../../src/features/goal/index.ts";
import { type GoalRecord, latestFromEntries } from "../../src/features/goal/state.ts";
import { createNotifyFeature } from "../../src/features/notify/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const verdict = (done: boolean, reason: string) => say(JSON.stringify({ done, reason }));
const blockedAlone = call("notify", { kind: "blocked", message: "needs a decision" });

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
		ctx.pi.events.on("goal:state", (payload) => probeEvents.push(payload as GoalStatePayload));
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
	ui?: { confirm(title: string, message: string): Promise<boolean> },
	goalOptions: { exec?: ExecFn; modelTimeoutMs?: number } = {},
): Promise<Harness> {
	notifyCalls = recordingExec();
	checkCalls = recordingExec(checkCode);
	harness = await createHarness({
		features: [
			createNotifyFeature({ exec: notifyCalls.exec }),
			createGoalFeature({ exec: checkCalls.exec, ...goalOptions }),
			probe,
		],
		...(ui ? { ui } : {}),
	});
	return harness;
}

afterEach(() => {
	harness?.dispose();
	harness = undefined;
	probeEvents.length = 0;
	slowStep = newSlowStep();
	clearReloadState();
});

const goalRecord = (h: Harness): GoalRecord | undefined => latestFromEntries(h.session.sessionManager.getBranch());
const isAdjudication = (messages: Message[]) => JSON.stringify(messages).includes("You are adjudicating");
const mainRequests = (h: Harness) => h.requests.filter((messages) => !isAdjudication(messages));
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
	it("starts, continues at the settle boundary, and ends on an accepted claim", async () => {
		const h = await start();
		h.respond([
			say("working on it"),
			call("goal_done", { evidence: "ran the tests" }),
			verdict(true, "tests are green"),
		]);
		await h.session.prompt("/goal ship the feature");
		await h.waitForRequests(3);
		await settle(h);

		const [first, second] = mainRequests(h);
		expect(JSON.stringify(first)).toContain("Goal set.");
		expect(JSON.stringify(first)).toContain("ship the feature");
		expect(JSON.stringify(second)).toContain("Goal continuation 2.");
		expect(goalRecord(h)?.state).toBe("achieved");
		expect(h.requests).toHaveLength(3);
		expect(notifyCalls.calls.find((entry) => entry.command === "notify-send")?.args).toContain("pi goal: achieved");
		expect(probeEvents.at(-1)).toEqual({ state: "achieved", turns: expect.any(Number) as number });
		expect(probeEvents[0]).toEqual({});
		expect(probeEvents).toContainEqual({ state: "active", turns: 0 });
		expect(h.extensionErrors).toEqual([]);

		h.respond([say("you are welcome")]);
		await h.session.prompt("thanks");
		await settle(h);
		expect(mainRequests(h)).toHaveLength(3);
		expectPrefixChain(mainRequests(h));
	});

	it("rejects claims through the check command and pauses at the rejection budget", async () => {
		const h = await start(1);
		h.respond([call("goal_wait", { reason: "CI result" })]);
		await h.session.prompt("/goal all tests pass");
		await h.waitForRequests(1);
		await settle(h);
		expect(goalRecord(h)?.waiting?.reason).toBe("CI result");

		await h.session.prompt("/goal-check npm test");
		expect(goalRecord(h)?.check).toBe("npm test");
		h.respond(Array.from({ length: 5 }, () => call("goal_done", { evidence: "ran npm test" })));
		await h.session.prompt("/goal resume");
		await h.waitForRequests(6);
		await settle(h);

		const record = goalRecord(h);
		expect(record).toMatchObject({ state: "paused", pauseReason: "rejected-claims", rejected: 5 });
		const checks = checkCalls.calls.filter((entry) => entry.command === "bash");
		expect(checks).toHaveLength(5);
		expect(checks[0]).toEqual({ command: "bash", args: ["-c", "npm test"], cwd: h.cwd });
		expect(toolTexts(h.requests[2]).join("\n")).toContain("Claim rejected (check): check command exited 1");
		expect(JSON.stringify(h.requests[1])).toContain("The goal condition changed.");
		expect(JSON.stringify(h.requests[1])).toContain("npm test");
		expect(h.requests).toHaveLength(6);
		expectPrefixChain(h.requests);
		const ping = notifyCalls.calls.find((entry) => entry.command === "notify-send");
		expect(ping?.args).toContain("pi goal: paused");
	});

	it("delivers the timeout of an armed wait as a timeout, not as stale", async () => {
		const h = await start();
		h.respond([call("goal_wait", { reason: "CI result", timeoutMs: 50 }), blockedAlone]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
		await settle(h, 200);

		const woken = JSON.stringify(h.requests[1]);
		expect(woken).toContain("The external wait timed out: CI result.");
		expect(woken).not.toContain("stale");
		expect(h.requests).toHaveLength(2);
		expect(goalRecord(h)?.pauseReason).toBe("blocked");
	});

	it("refuses goal_done called from inside another tool", async () => {
		const h = await start();
		h.respond([call("nested_claim", {}), call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(2);
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

	it("keeps a wait armed in this process across reload and pauses it once the process state is gone", async () => {
		const h = await start();
		h.respond([call("goal_wait", { reason: "deploy" })]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(1);
		await settle(h);

		await h.session.reload();
		expect(goalRecord(h)?.state).toBe("active");
		expect(goalRecord(h)?.waiting?.reason).toBe("deploy");

		clearReloadState();
		await h.session.reload();
		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "wake-source-lost" });
		expect(notifyCalls.calls).toEqual([]);
	});

	it("answers goal tools outside a goal with no side effects", async () => {
		const h = await start();
		h.respond([call("goal_wait", { reason: "x" }), call("goal_done", { evidence: "y" }), say("ok")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		expect(toolTexts(h.requests[1])).toEqual(["No goal is active."]);
		expect(toolTexts(h.requests[2]).at(-1)).toBe("No goal is active.");
		expect(goalRecord(h)).toBeUndefined();
	});

	it("sets a goal from a long verb-like phrase and treats /goal check as goal text", async () => {
		const h = await start();
		h.respond([call("goal_wait", { reason: "a" }), call("goal_wait", { reason: "b" })]);
		await h.session.prompt("/goal pause the server for maintenance");
		await h.waitForRequests(1);
		await settle(h);
		expect(goalRecord(h)?.condition).toBe("pause the server for maintenance");
		await h.session.prompt("/goal check npm test");
		await h.waitForRequests(2);
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
		h.respond([call("slow_step", {}), call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal first goal");
		await slowStep.running;
		await h.session.prompt("/goal second goal");
		slowStep.release();
		await h.waitForRequests(2);
		await settle(h);

		const second = JSON.stringify(h.requests[1]);
		expect(second).toContain("OLD-GOAL-RESULT slow step done");
		expect(second).not.toContain("slow step aborted");
		expect(second.indexOf("OLD-GOAL-RESULT")).toBeLessThan(second.indexOf("second goal"));
		expect(goalEntries(h).some((record) => record.state === "paused")).toBe(false);
		expect(goalRecord(h)).toMatchObject({ condition: "second goal", state: "active" });
		expect(notifyCalls.calls).toEqual([]);
	});

	it("the old goal's late tool result does not count as evidence for the new goal", async () => {
		const h = await start();
		h.respond([call("slow_step", {}), call("goal_done", { evidence: "see above" }), verdict(false, "no proof")]);
		await h.session.prompt("/goal first goal");
		await slowStep.running;
		await h.session.prompt("/goal second goal");
		slowStep.release();
		await h.waitForRequests(3);
		await settle(h);

		const adjudication = h.requests.find(isAdjudication);
		expect(adjudication).toBeDefined();
		expect(JSON.stringify(adjudication)).not.toContain("OLD-GOAL-RESULT");
		const record = goalRecord(h);
		expect(record?.evidenceFrom).toBeGreaterThan(record?.createdAt ?? Infinity);
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

	it("an aborted run pauses with user-input, not run-error", async () => {
		const h = await start();
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

		expect(goalRecord(h)).toMatchObject({ state: "paused", pauseReason: "user-input" });
		expect(goalEntries(h).some((record) => record.pauseReason === "run-error")).toBe(false);
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
		h.respond([call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal first goal");
		await h.waitForRequests(1);
		await settle(h);
		const before = goalRecord(h);

		await h.session.prompt("/goal second goal");
		expect(asked).toEqual([["Replace the current goal?", "Current: first goal\n\nNew: second goal"]]);
		expect(goalRecord(h)).toEqual(before);
		expect(h.requests).toHaveLength(1);
	});

	it("/goal l resume with a paused goal asks the typo question, and No keeps the paused goal unchanged", async () => {
		const asked: string[] = [];
		const h = await start(0, {
			confirm: async (title) => {
				asked.push(title);
				return false;
			},
		});
		h.respond([call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal first line\nsecond line\nthird line\nfourth line");
		await h.waitForRequests(1);
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
		h.respond([call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(1);
		await settle(h);
		await h.session.prompt("/goal pause");
		const paused = goalRecord(h);

		await h.session.prompt("/goal l resume");
		expect(goalRecord(h)).toEqual(paused);
		expect(h.requests).toHaveLength(1);
	});
});

describe("check adjudication limits", () => {
	it("bounds a check by its own timeout, not by the model adjudication cap", async () => {
		const seen: { timeoutMs?: number | undefined; abortedAtEnd?: boolean }[] = [];
		const slowCheck: ExecFn = async (_command, _args, options) => {
			const entry: (typeof seen)[number] = { timeoutMs: options?.timeoutMs };
			seen.push(entry);
			await new Promise((resolve) => setTimeout(resolve, 200));
			entry.abortedAtEnd = options?.signal?.aborted ?? true;
			return { code: 0, stdout: "", stderr: "" };
		};
		const h = await start(0, undefined, { exec: slowCheck, modelTimeoutMs: 20 });
		h.respond([call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(1);
		await settle(h);
		await h.session.prompt("/goal-check npm test");
		h.respond([call("goal_done", { evidence: "ran it" })]);
		await h.session.prompt("/goal resume");
		await h.waitForRequests(2);
		await settle(h);

		expect(seen).toEqual([{ timeoutMs: 15 * 60_000, abortedAtEnd: false }]);
		expect(goalRecord(h)?.state).toBe("achieved");
	});

	it("writes no verdict when the session reloads during an adjudication", async () => {
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
		h.respond([call("goal_wait", { reason: "build" })]);
		await h.session.prompt("/goal ship it");
		await h.waitForRequests(1);
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

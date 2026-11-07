import {
	type AssistantMessage,
	fauxAssistantMessage,
	type FauxResponseStep,
	fauxText,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature, type FeatureContext } from "../../src/core/feature.ts";
import { createHarness, type Harness } from "../support/harness.ts";

function makeWaker(id: string) {
	let captured: FeatureContext<unknown> | undefined;
	const feature = defineFeature({
		id,
		description: "test feature that wakes the model",
		defaultEnabled: true,
		setup(ctx) {
			captured = ctx as FeatureContext<unknown>;
			ctx.pi.registerTool({
				name: `${id}_echo`,
				label: "Echo",
				description: "Echo text back",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_id, params) => ({ content: [{ type: "text", text: `echo:${params.text}` }], details: {} }),
			});
		},
	});
	const wake = (text: string) => {
		if (!captured) throw new Error(`${id} did not set up`);
		captured.wake({ customType: id, content: text, display: true });
	};
	const context = () => {
		if (!captured) throw new Error(`${id} did not set up`);
		return captured;
	};
	return { feature, wake, context };
}

interface Latch {
	promise: Promise<void>;
	open(): void;
}

function latch(): Latch {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const say = (text: string) => fauxAssistantMessage(fauxText(text));
const failed = (text: string) => fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: text });
const big = (marker: string) => `${marker} ${"x".repeat(100_000)}`;
const has = (messages: Message[] | undefined, needle: string) => JSON.stringify(messages ?? []).includes(needle);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function held(started: Latch, release: Latch, reply: AssistantMessage): FauxResponseStep {
	return async () => {
		started.open();
		await release.promise;
		return reply;
	};
}

function recordLog(harness: Harness): string[] {
	const log: string[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "compaction_start" || event.type === "compaction_end")
			log.push(`${event.type}:${event.reason}@${harness.requests.length}`);
		if (event.type === "agent_start") log.push(`agent_start@${harness.requests.length}`);
	});
	return log;
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<number> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await sleep(20);
	}
	return Date.now() - started;
}

const requestWith = (harness: Harness, needle: string) =>
	harness.requests.findIndex((messages) => has(messages, needle));

const compactionEntries = (harness: Harness) =>
	harness.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

describe("ctx.wake", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	async function twoBigTurns(h: Harness, extra: FauxResponseStep[]): Promise<void> {
		h.respond([say("R1"), say("R2"), ...extra]);
		await h.session.prompt(big("OLD-P1"));
		await h.session.prompt(big("OLD-P2"));
	}

	it("starts no request during a manual compaction and wakes on the compacted context", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, say("SUMMARY-MANUAL")), say("WOKE")]);
		const log = recordLog(harness);

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-ONE");
		await sleep(100);
		const requestsWhileCompacting = harness.requests.length;
		release.open();
		await compacting;
		await harness.waitForRequests(4);

		expect(requestsWhileCompacting).toBe(3);
		expect(log).toEqual(["compaction_start:manual@2", "compaction_end:manual@3", "agent_start@3"]);
		const woken = harness.requests[requestWith(harness, "WAKE-ONE")];
		expect(has(woken, "SUMMARY-MANUAL")).toBe(true);
		expect(has(woken, "OLD-P1")).toBe(false);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("gives exactly one compaction entry when auto compaction is on", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [
			held(started, release, say("SUMMARY-MANUAL")),
			say("SUMMARY-AUTO"),
			say("WOKE"),
			say("SPARE"),
		]);
		harness.session.settingsManager.setCompactionEnabled(true);
		const model = harness.session.model;
		if (!model) throw new Error("no model");
		model.contextWindow = 60_000;

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-ONE");
		await sleep(100);
		release.open();
		await compacting;
		await waitFor(() => requestWith(harness as Harness, "WAKE-ONE") !== -1, 5_000, "the wake request");
		await harness.session.waitForIdle();

		expect(compactionEntries(harness).map((entry) => entry.summary)).toEqual(["SUMMARY-MANUAL"]);
	});

	it("puts a wake from an in-run threshold compaction into the same run's next request", async () => {
		const run = async (withWake: boolean) => {
			const waker = makeWaker("probe");
			const h = await createHarness({ features: [waker.feature] });
			harness = h;
			const started = latch();
			const release = latch();
			h.session.settingsManager.setCompactionEnabled(true);
			const model = h.session.model;
			if (!model) throw new Error("no model");
			model.contextWindow = 60_000;
			h.respond([
				say("R1"),
				fauxAssistantMessage(fauxToolCall("probe_echo", { text: "hi" }), { stopReason: "toolUse" }),
				held(started, release, say("SUMMARY-AUTO")),
				say("DONE"),
				say("SPARE"),
			]);
			await h.session.prompt(big("OLD-P1"));
			const prompting = h.session.prompt(big("OLD-P2"));
			await started.promise;
			if (withWake) waker.wake("WAKE-INRUN");
			await sleep(100);
			release.open();
			await prompting;
			await h.session.waitForIdle();
			const result = {
				requests: h.requests.length,
				entries: h.session.sessionManager
					.getEntries()
					.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
				last: h.requests.at(-1),
			};
			h.dispose();
			harness = undefined;
			return result;
		};

		const without = await run(false);
		const withWake = await run(true);

		expect(withWake.requests).toBe(without.requests);
		expect(withWake.entries).toEqual([...without.entries.slice(0, -1), "custom_message", ...without.entries.slice(-1)]);
		expect(withWake.entries.indexOf("compaction")).toBeLessThan(withWake.entries.indexOf("custom_message"));
		expect(has(withWake.last, "WAKE-INRUN")).toBe(true);
		expect(has(withWake.last, "SUMMARY-AUTO")).toBe(true);
	});

	it("delivers a wake held during a failed compaction after session_compact_failed", async () => {
		const waker = makeWaker("probe");
		const events: string[] = [];
		const observer: ExtensionFactory = (pi) => {
			pi.on("session_compact_failed", () => {
				events.push("session_compact_failed");
			});
		};
		harness = await createHarness({ features: [waker.feature], extensions: [observer] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, failed("summary broke")), say("WOKE")]);
		const log = recordLog(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") events.push("agent_start");
		});

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-FAILED");
		await sleep(100);
		release.open();
		await expect(compacting).rejects.toThrow();
		await harness.waitForRequests(4);

		expect(log).toEqual(["compaction_start:manual@2", "compaction_end:manual@3", "agent_start@3"]);
		expect(events).toEqual(["session_compact_failed", "agent_start"]);
		expect(requestWith(harness, "WAKE-FAILED")).toBe(3);
	});

	it("delivers a wake held during a compaction that another extension cancels through the idle fallback", async () => {
		const waker = makeWaker("probe");
		const reached = latch();
		const cancel = latch();
		const canceller: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", async () => {
				reached.open();
				await cancel.promise;
				return { cancel: true };
			});
		};
		harness = await createHarness({ features: [waker.feature], extensions: [canceller] });
		await twoBigTurns(harness, [say("WOKE")]);

		const compacting = harness.session.compact();
		await reached.promise;
		waker.wake("WAKE-CANCELLED");
		await sleep(100);
		expect(harness.requests).toHaveLength(2);
		cancel.open();
		await expect(compacting).rejects.toThrow("Compaction cancelled");
		const waited = await waitFor(() => harness?.requests.length === 3, 3_000, "the held wake");
		await harness.session.waitForIdle();

		expect(waited).toBeLessThan(3_000);
		expect(has(harness.requests[2], "WAKE-CANCELLED")).toBe(true);
	});

	it("delivers a wake held during a user-aborted compaction through the idle fallback", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, say("SUMMARY-MANUAL")), say("WOKE")]);

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-ABORTED");
		const aborting = harness.session.abort();
		release.open();
		await aborting;
		await expect(compacting).rejects.toThrow();
		const requestsAfterAbort = harness.requests.length;
		const waited = await waitFor(() => harness?.requests.length === 4, 3_000, "the held wake");
		await harness.session.waitForIdle();

		expect(requestsAfterAbort).toBe(3);
		expect(waited).toBeLessThan(3_000);
		expect(has(harness.requests[3], "WAKE-ABORTED")).toBe(true);
	});

	it("drops a wake held during a compaction that a session replacement aborts", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, say("SUMMARY-MANUAL")), say("SPARE")]);
		const runtime = harness.runtime;

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-OLD-SESSION");
		// Same order as a session replacement: abort the session, then emit session_shutdown.
		const aborting = harness.session.abort();
		release.open();
		await aborting;
		await expect(compacting).rejects.toThrow();
		await harness.session.reload();
		await sleep(2_500);

		expect(harness.requests).toHaveLength(3);
		expect(requestWith(harness, "WAKE-OLD-SESSION")).toBe(-1);
		expect(runtime.diagnostics()).toContainEqual({
			feature: "pimon",
			level: "warning",
			message: "dropped held wakes at session_shutdown (reload): probe 1",
		});
	});

	it("delivers a wake held during a cancelled tree navigation through the idle fallback", async () => {
		const waker = makeWaker("probe");
		const reached = latch();
		const cancel = latch();
		const canceller: ExtensionFactory = (pi) => {
			pi.on("session_before_tree", async () => {
				reached.open();
				await cancel.promise;
				return { cancel: true };
			});
		};
		harness = await createHarness({ features: [waker.feature], extensions: [canceller] });
		harness.respond([say("R1"), say("R2"), say("WOKE")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const target = harness.session.sessionManager.getEntries().find((entry) => entry.type === "message");
		if (!target) throw new Error("no entry");

		const navigating = harness.session.navigateTree(target.id);
		await reached.promise;
		waker.wake("WAKE-TREE");
		await sleep(100);
		expect(harness.requests).toHaveLength(2);
		cancel.open();
		await expect(navigating).resolves.toMatchObject({ cancelled: true });
		const waited = await waitFor(() => harness?.requests.length === 3, 3_000, "the held wake");
		await harness.session.waitForIdle();

		expect(waited).toBeLessThan(3_000);
		expect(has(harness.requests[2], "WAKE-TREE")).toBe(true);
	});

	it("delivers a wake held during a failed tree summary through the idle fallback", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		const started = latch();
		const release = latch();
		harness.respond([say("R1"), say("R2"), held(started, release, failed("summary broke")), say("WOKE")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const target = harness.session.sessionManager.getEntries().find((entry) => entry.type === "message");
		if (!target) throw new Error("no entry");

		const navigating = harness.session.navigateTree(target.id, { summarize: true });
		await started.promise;
		waker.wake("WAKE-TREE-FAILED");
		await sleep(100);
		expect(harness.requests).toHaveLength(3);
		release.open();
		await expect(navigating).rejects.toThrow();
		const waited = await waitFor(() => harness?.requests.length === 4, 3_000, "the held wake");
		await harness.session.waitForIdle();

		expect(waited).toBeLessThan(3_000);
		expect(has(harness.requests[3], "WAKE-TREE-FAILED")).toBe(true);
	});

	it("keeps send order for wakes from two features during one compaction", async () => {
		const first = makeWaker("first");
		const second = makeWaker("second");
		harness = await createHarness({ features: [first.feature, second.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, say("SUMMARY-MANUAL")), say("WOKE"), say("SPARE")]);

		const compacting = harness.session.compact();
		await started.promise;
		first.wake("WAKE-FIRST");
		second.wake("WAKE-SECOND");
		await sleep(100);
		release.open();
		await compacting;
		await waitFor(() => requestWith(harness as Harness, "WAKE-SECOND") !== -1, 5_000, "both wakes");
		await harness.session.waitForIdle();

		const custom = harness.session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : []));
		expect(custom).toEqual(["first", "second"]);
	});

	it("filters a held wake from another feature at flush time and logs a throwing filter", async () => {
		const waker = makeWaker("probe");
		const redactor = makeWaker("redactor");
		harness = await createHarness({ features: [waker.feature, redactor.feature] });
		const started = latch();
		const release = latch();
		await twoBigTurns(harness, [held(started, release, say("SUMMARY-MANUAL")), say("WOKE")]);
		const secrets: string[] = [];
		redactor.context().wakeFilter((message) => {
			if (typeof message.content !== "string") return message;
			let content = message.content;
			for (const secret of secrets) content = content.replaceAll(secret, "[redacted]");
			return { ...message, content };
		});
		redactor.context().wakeFilter(() => {
			throw new Error("boom");
		});

		const compacting = harness.session.compact();
		await started.promise;
		waker.wake("WAKE-HELD token=HUNTER2");
		secrets.push("HUNTER2");
		release.open();
		await compacting;
		await harness.waitForRequests(4);
		await harness.session.waitForIdle();

		expect(has(harness.requests[3], "WAKE-HELD token=[redacted]")).toBe(true);
		expect(has(harness.requests[3], "HUNTER2")).toBe(false);
		expect(harness.runtime.diagnostics()).toContainEqual({
			feature: "redactor",
			level: "error",
			message: "wake filter failed; the message was sent without it: boom",
		});
	});

	it("starts a run at once when idle and not compacting", async () => {
		const waker = makeWaker("probe");
		harness = await createHarness({ features: [waker.feature] });
		harness.respond([say("WOKE")]);

		waker.wake("WAKE-IDLE");
		await harness.waitForRequests(1, 1_000);

		expect(has(harness.requests[0], "WAKE-IDLE")).toBe(true);
		expect(harness.requests).toHaveLength(1);
	});

	it("drops held wakes on shutdown, logs the count, and does not deliver them later", async () => {
		const waker = makeWaker("probe");
		const reached = latch();
		const cancel = latch();
		const canceller: ExtensionFactory = (pi) => {
			pi.on("session_before_tree", async () => {
				reached.open();
				await cancel.promise;
				return { cancel: true };
			});
		};
		harness = await createHarness({ features: [waker.feature], extensions: [canceller] });
		harness.respond([say("R1"), say("R2"), say("SPARE")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const target = harness.session.sessionManager.getEntries().find((entry) => entry.type === "message");
		if (!target) throw new Error("no entry");
		const runtime = harness.runtime;

		const navigating = harness.session.navigateTree(target.id);
		await reached.promise;
		waker.wake("WAKE-DROPPED");
		waker.wake("WAKE-DROPPED");
		await harness.session.reload();
		cancel.open();
		await navigating;
		await sleep(2_500);

		expect(harness.requests).toHaveLength(2);
		expect(runtime.diagnostics()).toContainEqual({
			feature: "pimon",
			level: "warning",
			message: "dropped held wakes at session_shutdown (reload): probe 2",
		});
	});
});

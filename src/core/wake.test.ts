import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WakeMessage } from "./feature.ts";
import { createWakeGate } from "./wake.ts";

const message = (text: string): WakeMessage => ({ customType: "probe", content: text });

const text = (wake: WakeMessage) => (typeof wake.content === "string" ? wake.content : "");

function redact(secret: string) {
	return (wake: WakeMessage): WakeMessage => ({
		...wake,
		content:
			typeof wake.content === "string"
				? wake.content.replaceAll(secret, "***")
				: wake.content.map((part) =>
						part.type === "text" ? { ...part, text: part.text.replaceAll(secret, "***") } : part,
					),
	});
}

function setup() {
	const sent: string[] = [];
	const warnings: string[] = [];
	let idle: boolean | "throw" = false;
	const gate = createWakeGate({
		send: (wake) => sent.push(typeof wake.content === "string" ? wake.content : JSON.stringify(wake.content)),
		isIdle: () => {
			if (idle === "throw") throw new Error("stale context");
			return idle;
		},
		warn: (text) => warnings.push(text),
	});
	return {
		gate,
		sent,
		warnings,
		setIdle: (value: boolean | "throw") => {
			idle = value;
		},
	};
}

describe("wake gate", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends at once when not holding", () => {
		const { gate, sent } = setup();
		gate.wake("probe", message("a"));
		expect(sent).toEqual(["a"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds while holding and flushes in send order on release", () => {
		const { gate, sent } = setup();
		gate.hold();
		gate.wake("first", message("a"));
		gate.wake("second", message("b"));
		expect(sent).toEqual([]);
		gate.release();
		expect(sent).toEqual(["a", "b"]);
		expect(vi.getTimerCount()).toBe(0);
		gate.wake("first", message("c"));
		expect(sent).toEqual(["a", "b", "c"]);
	});

	it("keeps one fallback timer and releases on the first idle tick", () => {
		const { gate, sent, setIdle } = setup();
		gate.hold();
		gate.hold();
		gate.wake("probe", message("a"));
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(2_000);
		expect(sent).toEqual([]);
		setIdle(true);
		vi.advanceTimersByTime(2_000);
		expect(sent).toEqual(["a"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops held wakes on shutdown, warns with the count per feature, and leaves no timer", () => {
		const { gate, sent, warnings, setIdle } = setup();
		gate.hold();
		gate.wake("first", message("a"));
		gate.wake("second", message("b"));
		gate.wake("first", message("c"));
		gate.shutdown("reload");
		expect(vi.getTimerCount()).toBe(0);
		expect(warnings).toEqual(["dropped held wakes at session_shutdown (reload): first 2, second 1"]);
		setIdle(true);
		vi.advanceTimersByTime(10_000);
		gate.release();
		expect(sent).toEqual([]);
	});

	it("ignores wake, hold, and release after shutdown", () => {
		const { gate, sent, warnings, setIdle } = setup();
		gate.shutdown("new");
		gate.wake("probe", message("a"));
		gate.hold();
		gate.wake("probe", message("b"));
		expect(vi.getTimerCount()).toBe(0);
		setIdle(true);
		vi.advanceTimersByTime(10_000);
		gate.release();
		gate.shutdown("quit");
		expect(sent).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("stops the fallback when isIdle throws and keeps the wakes for shutdown", () => {
		const { gate, sent, warnings, setIdle } = setup();
		gate.hold();
		gate.wake("probe", message("a"));
		setIdle("throw");
		expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
		expect(sent).toEqual([]);
		gate.shutdown("new");
		expect(warnings).toEqual(["dropped held wakes at session_shutdown (new): probe 1"]);
	});

	it("filters string content and text parts and leaves other parts", () => {
		const seen: WakeMessage[] = [];
		const gate = createWakeGate({ send: (wake) => seen.push(wake), isIdle: () => true, warn: () => {} });
		gate.addFilter("redact", redact("s3cret"), () => {});
		gate.wake("probe", message("token s3cret"));
		const image = { type: "image" as const, data: "s3cret", mimeType: "image/png" };
		gate.wake("probe", { customType: "probe", content: [{ type: "text", text: "a s3cret b" }, image] });
		expect(seen.map((wake) => wake.content)).toEqual(["token ***", [{ type: "text", text: "a *** b" }, image]]);
	});

	it("runs filters in registration order", () => {
		const { gate, sent } = setup();
		gate.addFilter(
			"one",
			(wake) => ({ ...wake, content: `${text(wake)}+one` }),
			() => {},
		);
		gate.addFilter(
			"two",
			(wake) => ({ ...wake, content: `${text(wake)}+two` }),
			() => {},
		);
		gate.wake("probe", message("a"));
		expect(sent).toEqual(["a+one+two"]);
	});

	it("skips a throwing filter, still sends, and logs once per feature", () => {
		const { gate, sent } = setup();
		const errors: string[] = [];
		gate.addFilter(
			"broken",
			() => {
				throw new Error("boom");
			},
			(text, cause) => errors.push(`${text}: ${(cause as Error).message}`),
		);
		gate.addFilter("redact", redact("s3cret"), () => {});
		gate.wake("probe", message("a s3cret"));
		gate.wake("probe", message("b"));
		expect(sent).toEqual(["a ***", "b"]);
		expect(errors).toEqual(["wake filter failed; the message was sent without it: boom"]);
	});

	it("filters a held wake at flush time", () => {
		const { gate, sent } = setup();
		const secrets = ["early"];
		gate.addFilter(
			"redact",
			(wake) => secrets.reduce((acc, secret) => redact(secret)(acc), wake),
			() => {},
		);
		gate.hold();
		gate.wake("probe", message("early late other"));
		secrets.push("late");
		gate.addFilter(
			"upper",
			(wake) => ({ ...wake, content: text(wake).toUpperCase() }),
			() => {},
		);
		gate.release();
		expect(sent).toEqual(["*** *** OTHER"]);
	});

	it("does not warn on shutdown when nothing is held", () => {
		const { gate, warnings } = setup();
		gate.shutdown("quit");
		expect(warnings).toEqual([]);
	});
});

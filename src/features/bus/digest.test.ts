import { describe, expect, it } from "vite-plus/test";
import type { PendingResult } from "../../hub/protocol.ts";
import { MAX_DIGEST_BYTES, MAX_DIGEST_ITEMS, renderDigest, renderOpenState } from "./digest.ts";
import type { BusMessage } from "./protocol.ts";

const SENDER = "33333333-4444-7000-8000-000000000000";

function message(index: number, body = `body ${index}`, extra: Partial<BusMessage> = {}): BusMessage {
	return {
		id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
		threadId: "11111111-0000-4000-8000-000000000000",
		from: { id: SENDER, name: "sender" },
		direction: "in",
		kind: "note",
		wake: "now",
		body,
		createdAt: index,
		...extra,
	};
}

describe("digest text", () => {
	it("shows the message id and the sender id for each item", () => {
		const { text } = renderDigest({ messages: [message(1, "hello")], notices: [] });
		expect(text).toContain("- note from sender id:333333334444 messageId=000000010000:");
		expect(text).toContain("threadId: 111111110000");
		expect(text).toContain("  hello");
	});

	it("names a sender that is a hub principal, not an agent", () => {
		const item = message(1, "please summarize", { from: { name: "hermes" }, kind: "task", taskId: "t1" });
		const { text } = renderDigest({ messages: [item], notices: [] });
		expect(text).toContain("- task from hermes messageId=000000010000:");
	});

	it("shows a subject only when it differs from the thread title", () => {
		const first = message(1, "do it", { subject: "Delegated task" });
		const second = message(2, "also this", { subject: "Follow up" });
		const { text } = renderDigest({ messages: [first, second], notices: [] });
		expect(text.split("\n")).toEqual([
			"Thread: Delegated task",
			"threadId: 111111110000",
			"- note from sender id:333333334444 messageId=000000010000:",
			"  do it",
			"- note from sender id:333333334444 messageId=000000020000:",
			"  subject: Follow up",
			"  also this",
		]);
	});

	it("names the question that an answer settles", () => {
		const question = message(1, "what now?");
		const sent = new Map([[question.id, "what now?"]]);
		const { text } = renderDigest({ messages: [message(2, "this", { replyTo: question.id })], notices: [] }, sent);
		expect(text).toContain('answering your "what now?"');
	});

	it("shows the task state of a task update", () => {
		const update = message(1, "done", { kind: "result", taskId: "t1", taskState: "completed" });
		expect(renderDigest({ messages: [update], notices: [] }).text).toContain(
			"- result from sender id:333333334444 messageId=000000010000 task completed:",
		);
	});

	it("caps items and bytes and counts the rest as unread", () => {
		const many = Array.from({ length: 12 }, (_, index) => message(index + 1));
		const byCount = renderDigest({ messages: many, notices: ["peer left"] });
		expect(byCount.included).toHaveLength(MAX_DIGEST_ITEMS);
		expect(byCount.text).toContain("- 4 more peer message(s) remain unread.");
		expect(byCount.text).toContain("- peer left");

		const big = Array.from({ length: 8 }, (_, index) => message(index + 1, "x".repeat(1_100)));
		const byBytes = renderDigest({ messages: big, notices: [] });
		expect(Buffer.byteLength(byBytes.text)).toBeLessThan(MAX_DIGEST_BYTES + 200);
		expect(byBytes.omitted.length).toBeGreaterThan(0);
	});

	it("keeps a 2000-byte body whole", () => {
		const body = "z".repeat(2_000);
		const { text } = renderDigest({ messages: [message(1, body)], notices: [] });
		expect(text).toContain(body);
		expect(text).not.toContain("[truncated;");
	});

	it("cuts a long body and points to the read action", () => {
		const { text } = renderDigest({ messages: [message(1, "y".repeat(5_000))], notices: [] });
		expect(text).toContain('[truncated; read it with action="read"]');
	});
});

describe("open state after compaction", () => {
	const empty: PendingResult = { expectReply: [], tasks: [] };

	it("is empty when nothing is open", () => {
		expect(renderOpenState(0, empty, empty)).toBeUndefined();
	});

	it("lists what this session waits for and what it owes", () => {
		const pending: PendingResult = {
			expectReply: [
				{
					messageId: "aaaaaaaa-0000-4000-8000-000000000000",
					contextId: "c",
					taskId: null,
					agent: SENDER,
					name: "bob",
					createdAt: "",
				},
			],
			tasks: [],
		};
		const owed: PendingResult = {
			expectReply: [],
			tasks: [
				{
					taskId: "bbbbbbbb-0000-4000-8000-000000000000",
					contextId: "c",
					agent: null,
					name: "hermes",
					state: "working",
					createdAt: "",
				},
			],
		};
		expect(renderOpenState(2, pending, owed)?.split("\n")).toEqual([
			"Bus state kept across compaction. Unread messages: 2.",
			"- Pending question messageId=aaaaaaaa0000 to bob id:333333334444",
			"- Open task bbbbbbbb0000 from hermes: working",
		]);
	});
});

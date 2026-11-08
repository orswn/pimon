import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAX_DIGEST_BYTES, MAX_DIGEST_ITEMS, renderDigest } from "./digest.ts";
import type { Envelope } from "./protocol.ts";
import { busDirs, ensureDirs } from "./registry.ts";
import { BusStore } from "./store.ts";

let root: string;
let store: BusStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-digest-"));
	store = new BusStore(undefined, ensureDirs(busDirs(root)));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function envelope(index: number, body = `body ${index}`, extra: Partial<Envelope> = {}): Envelope {
	return {
		v: 1,
		id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
		threadId: "11111111-0000-4000-8000-000000000000",
		from: {
			instanceId: "22222222-0000-4000-8000-000000000000",
			owner: "33333333-4444-4000-8000-000000000000",
			name: "sender",
			pid: 1,
			cwd: "/",
			sock: "/s",
			labels: {},
		},
		to: "x",
		kind: "note",
		priority: "normal",
		wake: "now",
		body,
		createdAt: index,
		...extra,
	};
}

describe("digest text", () => {
	it("shows the message id and the sender owner for each item", () => {
		const item = envelope(1, "hello");
		const { text } = renderDigest(store, { envelopes: [item], notices: [] });
		expect(text).toContain("- note from sender owner:333333334444 messageId=000000010000:");
		expect(text).toContain("threadId: 111111110000");
		expect(text).toContain("  hello");
	});

	it("names the question that an answer settles", () => {
		const question = envelope(1, "what now?");
		store.addOutbound(question);
		const { text } = renderDigest(store, { envelopes: [envelope(2, "this", { corrId: question.id })], notices: [] });
		expect(text).toContain('answering your "what now?"');
	});

	it("caps items and bytes and counts the rest as unread", () => {
		const many = Array.from({ length: 12 }, (_, index) => envelope(index + 1));
		const byCount = renderDigest(store, { envelopes: many, notices: ["peer left"] });
		expect(byCount.included).toHaveLength(MAX_DIGEST_ITEMS);
		expect(byCount.text).toContain("- 4 more peer message(s) remain unread.");
		expect(byCount.text).toContain("- peer left");

		const big = Array.from({ length: 8 }, (_, index) => envelope(index + 1, "x".repeat(1_100)));
		const byBytes = renderDigest(store, { envelopes: big, notices: [] });
		expect(Buffer.byteLength(byBytes.text)).toBeLessThan(MAX_DIGEST_BYTES + 200);
		expect(byBytes.omitted.length).toBeGreaterThan(0);
	});

	it("keeps a 2000-byte body whole", () => {
		const body = "z".repeat(2_000);
		const { text } = renderDigest(store, { envelopes: [envelope(1, body)], notices: [] });
		expect(text).toContain(body);
		expect(text).not.toContain("[truncated;");
	});

	it("cuts a long body and points to the read action", () => {
		const { text } = renderDigest(store, { envelopes: [envelope(1, "y".repeat(5_000))], notices: [] });
		expect(text).toContain('[truncated; read it with action="read"]');
	});
});

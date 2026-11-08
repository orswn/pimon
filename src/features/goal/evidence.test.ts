import { describe, expect, it } from "vite-plus/test";
import { buildEvidence, DEFAULT_EVIDENCE_LIMITS } from "./evidence.ts";

const T0 = 1_700_000_000_000;
const assistant = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const bashResult = (text: string, at?: number) => ({
	type: "message",
	...(at === undefined ? {} : { timestamp: new Date(at).toISOString() }),
	message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
});

describe("evidence window", () => {
	const text = buildEvidence([
		{ type: "message", message: { role: "user", content: "do it" } },
		assistant("running tests"),
		bashResult("3 passed"),
	]);
	it("includes assistant text and labelled tool results, oldest first, without user messages", () => {
		expect(text).toContain("running tests");
		expect(text).toContain("<tool:bash>");
		expect(text).toContain("3 passed");
		expect(text).not.toContain("do it");
		expect(text.indexOf("running tests")).toBeLessThan(text.indexOf("3 passed"));
	});

	it("clips a huge item and says how much was dropped", () => {
		const clipped = buildEvidence([assistant("x".repeat(10_000))], {
			...DEFAULT_EVIDENCE_LIMITS,
			maxCharsPerItem: 100,
		});
		expect(clipped.length).toBeLessThan(400);
		expect(clipped).toContain("characters omitted");
	});

	const many = Array.from({ length: 100 }, (_, index) => assistant(`item ${index}`));
	it("holds the item cap and keeps the newest items", () => {
		const capped = buildEvidence(many, { maxItems: 5, maxCharsPerItem: 100, maxTotalChars: 10_000 });
		expect(capped.match(/<assistant>/g) ?? []).toHaveLength(5);
		expect(capped).toContain("item 99");
		expect(capped).not.toContain("item 50");
	});
	it("holds the total cap", () => {
		expect(buildEvidence(many, { maxItems: 100, maxCharsPerItem: 100, maxTotalChars: 200 }).length).toBeLessThanOrEqual(
			220,
		);
	});
	it("yields nothing for an empty branch or whitespace-only messages", () => {
		expect(buildEvidence([])).toBe("");
		expect(buildEvidence([assistant("   ")])).toBe("");
	});
});

describe("evidence is scoped to the goal", () => {
	const entries = [bashResult("OLD GOAL: 3 passed", T0 - 60_000), bashResult("NEW RUN: 4 passed", T0 + 60_000)];
	it("excludes evidence from before the goal and keeps evidence from during it", () => {
		const scoped = buildEvidence(entries, undefined, T0);
		expect(scoped).not.toContain("OLD GOAL");
		expect(scoped).toContain("NEW RUN");
		expect(buildEvidence(entries)).toContain("OLD GOAL");
	});
	it("understands a numeric message timestamp and excludes undated entries", () => {
		const numeric = [
			{
				type: "message",
				message: { role: "assistant", timestamp: T0 + 5, content: [{ type: "text", text: "numeric stamp" }] },
			},
		];
		expect(buildEvidence(numeric, undefined, T0)).toContain("numeric stamp");
		expect(buildEvidence([assistant("undated")], undefined, T0)).toBe("");
	});
});

describe("evidence boundary is the kickoff, not the creation", () => {
	const entries = [bashResult("REPLACED GOAL result", T0 + 500), bashResult("THIS GOAL result", T0 + 5_000)];
	it("excludes a replaced run when scoped by kickoff", () => {
		expect(buildEvidence(entries, undefined, T0)).toContain("REPLACED GOAL");
		expect(buildEvidence(entries, undefined, T0 + 1_000)).not.toContain("REPLACED GOAL");
		expect(buildEvidence(entries, undefined, T0 + 1_000)).toContain("THIS GOAL");
	});
});

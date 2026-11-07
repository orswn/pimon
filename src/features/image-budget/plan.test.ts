import { describe, expect, it } from "vite-plus/test";
import { type Block, DEFAULT_BUDGET, estimateBytes, type PlanEntry, planOmissions } from "./plan.ts";

const MB = 1_000_000;
const image = (bytes: number): Block => ({ type: "image", mimeType: "image/png", data: "A".repeat(bytes) });
const read = (id: string, bytes: number): PlanEntry => ({
	id,
	role: "toolResult",
	content: [{ type: "text", text: "Read image file [image/png]" }, image(bytes)],
});
const user = (id: string, text: string, extra: Block[] = []): PlanEntry => ({
	id,
	role: "user",
	content: [{ type: "text", text }, ...extra],
});
const session = (n: number, bytes = MB) => [
	user("u0", "start"),
	...Array.from({ length: n }, (_, i) => read(`r${i}`, bytes)),
];

describe("planOmissions trigger", () => {
	it("omits nothing below the trigger", () => {
		expect(planOmissions(session(27)).omissions).toEqual([]);
	});

	it("trims above the trigger down to the target and no further than needed", () => {
		const plan = planOmissions(session(30));
		expect(plan.omissions.length).toBeGreaterThan(0);
		expect(plan.afterBytes).toBeLessThanOrEqual(20 * MB);
		expect(plan.afterBytes).toBeGreaterThan(19 * MB);
	});

	it("predicts the size a re-measure finds", () => {
		const plan = planOmissions(session(30));
		const edited = session(30).map((entry) => {
			const omission = plan.omissions.find((o) => o.targetId === entry.id);
			return omission ? { ...entry, content: omission.content } : entry;
		});
		expect(Math.abs(estimateBytes(edited) - plan.afterBytes)).toBeLessThan(10);
	});

	it("uses a custom budget", () => {
		const budget = { triggerBytes: 3000, targetBytes: 2500, keepRecentImages: 1 };
		const plan = planOmissions(session(5, 1000), budget);
		expect(plan.omissions.map((o) => o.targetId)).toEqual(["r0", "r1", "r2", "r3"]);
		expect(plan.afterBytes).toBeLessThanOrEqual(budget.targetBytes);
	});
});

describe("planOmissions order and protection", () => {
	it("omits the oldest first and keeps the newest eight images", () => {
		const plan = planOmissions(session(30));
		expect(plan.omissions[0]?.targetId).toBe("r0");
		const ids = new Set(plan.omissions.map((o) => o.targetId));
		for (let i = 0; i < DEFAULT_BUDGET.keepRecentImages; i++) expect(ids.has(`r${29 - i}`)).toBe(false);
	});

	it("keeps protected entries and user images, and reports an unreachable target", () => {
		const guarded = planOmissions(session(30), DEFAULT_BUDGET, { protectedIds: new Set(["r0", "r1"]) });
		expect(guarded.omissions.some((o) => o.targetId === "r0" || o.targetId === "r1")).toBe(false);
		const userPlan = planOmissions([user("u1", "look", [image(25 * MB)]), read("r0", 4 * MB)]);
		expect(userPlan.omissions.some((o) => o.targetId === "u1")).toBe(false);
		expect(userPlan.reachedTarget).toBe(false);
	});
});

describe("planOmissions replacement content", () => {
	it("replaces only image blocks and names the path when known", () => {
		const plan = planOmissions(session(30), DEFAULT_BUDGET, {
			toolCallIds: new Map([["r0", "call-0"]]),
			paths: new Map([["call-0", "/tmp/shot.png"]]),
		});
		const content = plan.omissions[0]?.content ?? [];
		expect(content.some((block) => block.type === "image")).toBe(false);
		expect(content[0]?.text).toBe("Read image file [image/png]");
		expect(content[1]?.text).toContain("/tmp/shot.png");
		expect(planOmissions(session(30)).omissions[0]?.content[1]?.text).toMatch(/^\[Image omitted/);
	});
});

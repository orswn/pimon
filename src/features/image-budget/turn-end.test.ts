import { describe, expect, it } from "vite-plus/test";
import { imageBudget } from "./index.ts";
import { DEFAULT_BUDGET } from "./plan.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function turnEndHandler(): Handler {
	const handlers = new Map<string, Handler>();
	const ctx = { config: DEFAULT_BUDGET, pi: { on: (name: string, handler: Handler) => handlers.set(name, handler) } };
	imageBudget.setup(ctx as never);
	const handler = handlers.get("turn_end");
	if (!handler) throw new Error("no turn_end handler");
	return handler;
}

describe("image-budget turn end", () => {
	it("does not serialize a context that has no image", () => {
		let serialized = 0;
		const block = {
			type: "text",
			text: "hello",
			toJSON() {
				serialized++;
				return { type: "text", text: "hello" };
			},
		};
		const event = {
			context: {
				contextEntries: [
					{ sourceEntry: { id: "e1", type: "message" }, messages: [{ role: "user", content: [block] }] },
				],
			},
			toolResultEntryIds: [],
			entries: [],
		};
		expect(turnEndHandler()(event, { hasUI: false })).toBeUndefined();
		expect(serialized).toBe(0);
	});
});

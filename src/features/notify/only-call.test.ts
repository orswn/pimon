import { describe, expect, it } from "vite-plus/test";
import { checkOnlyCall, siblingToolCalls } from "./only-call.ts";

const assistant = (...calls: { id: string; name: string }[]) => ({
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "x" }, ...calls.map((call) => ({ type: "toolCall", ...call }))],
	},
});

describe("sibling tool calls", () => {
	it("names the other calls in the same assistant message", () => {
		const branch = [assistant({ id: "a", name: "notify" }, { id: "b", name: "bash" })];
		expect(siblingToolCalls(branch, "a")).toEqual(["bash"]);
	});
	it("finds nothing for a call alone in its message", () => {
		expect(siblingToolCalls([assistant({ id: "a", name: "notify" })], "a")).toEqual([]);
	});
	it("looks only at the newest assistant message", () => {
		const branch = [
			assistant({ id: "a", name: "notify" }, { id: "b", name: "bash" }),
			assistant({ id: "c", name: "read" }),
		];
		expect(siblingToolCalls(branch, "a")).toEqual([]);
	});
});

describe("only-call check", () => {
	const ctx = (branch: unknown[]) => ({ sessionManager: { getBranch: () => branch } }) as never;
	it("flags a nested call from a script", () => {
		expect(checkOnlyCall({ toolCallId: "p/1", parentToolCallId: "p" }, ctx([]))).toEqual({
			nested: true,
			siblings: [],
		});
	});
	it("flags siblings", () => {
		const branch = [assistant({ id: "a", name: "notify" }, { id: "b", name: "bash" })];
		expect(checkOnlyCall({ toolCallId: "a" }, ctx(branch))).toEqual({ nested: false, siblings: ["bash"] });
	});
	it("passes a direct call alone", () => {
		expect(checkOnlyCall({ toolCallId: "a" }, ctx([assistant({ id: "a", name: "notify" })]))).toBeUndefined();
	});
});

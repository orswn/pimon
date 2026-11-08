import { describe, expect, it } from "vite-plus/test";
import { type Feed, Parser } from "./parser.ts";

function feed(keys: string): { last: Feed; parser: Parser } {
	const parser = new Parser();
	let last: Feed = { kind: "none" };
	for (const key of keys) last = parser.feed(key);
	return { last, parser };
}

describe("parser", () => {
	it.each([
		["w", { type: "move", motion: { key: "w" }, count: 1, hasCount: false }],
		["3w", { type: "move", motion: { key: "w" }, count: 3, hasCount: true }],
		["0", { type: "move", motion: { key: "0" }, count: 1, hasCount: false }],
		["10l", { type: "move", motion: { key: "l" }, count: 10, hasCount: true }],
		["2d3w", { type: "operator", op: "d", target: { motion: { key: "w" } }, count: 6, hasCount: true }],
		["3dd", { type: "operator", op: "d", target: { line: true }, count: 3, hasCount: true }],
		["ciw", { type: "operator", op: "c", target: { object: "i", key: "w" }, count: 1, hasCount: false }],
		["ya(", { type: "operator", op: "y", target: { object: "a", key: "(" }, count: 1, hasCount: false }],
		["dfx", { type: "operator", op: "d", target: { motion: { key: "f", char: "x" } }, count: 1, hasCount: false }],
		["dgg", { type: "operator", op: "d", target: { motion: { key: "gg" } }, count: 1, hasCount: false }],
		["5gg", { type: "move", motion: { key: "gg" }, count: 5, hasCount: true }],
		["3rx", { type: "replace", char: "x", count: 3, hasCount: true }],
		["2D", { type: "simple", key: "D", count: 2, hasCount: true }],
	] as const)("%s", (keys, command) => {
		expect(feed(keys).last).toEqual({ kind: "command", command });
	});

	it("caps the total count at 9999", () => {
		const result = feed("99d999w").last;
		expect(result.kind === "command" && result.command.count).toBe(9999);
	});

	it.each([
		["3", " NORMAL 3_"],
		["3d", " NORMAL 3d_"],
		["2d3", " NORMAL 2d3_"],
		["di", " NORMAL di_"],
		["f", " NORMAL f_"],
		["g", " NORMAL g_"],
	])("shows %s as pending", (keys, label) => {
		const { parser } = feed(keys);
		expect(parser.pending).toBe(true);
		expect(` NORMAL ${parser.label()}`).toBe(label);
	});

	it.each(["v", ".", "/", "n", "gJ", "dz", "diz", ":"])("drops %s with no command", (keys) => {
		const { last, parser } = feed(keys);
		expect(last).toEqual({ kind: "none" });
		expect(parser.pending).toBe(false);
	});

	it("takeCount returns the typed count and resets", () => {
		const { parser } = feed("3");
		expect(parser.takeCount()).toBe(3);
		expect(parser.pending).toBe(false);
	});
});

import { describe, expect, it } from "vite-plus/test";
import { clampText, LineSplitter, sanitizeLine, stripAnsi } from "./lines.ts";

function split(maxLineChars: number, ...chunks: string[]): string[] {
	const seen: string[] = [];
	const splitter = new LineSplitter(maxLineChars, (line) => seen.push(line));
	for (const chunk of chunks) splitter.push(chunk);
	splitter.end();
	return seen;
}

describe("LineSplitter", () => {
	it("splits on LF, CRLF, and bare CR", () => {
		expect(split(10, "a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
	});

	it("force-breaks a line with no newline", () => {
		const forced = split(4, "x".repeat(11));
		expect(forced).toHaveLength(3);
		expect(forced[0]).toBe("xxxx");
	});

	it("splits a long line that arrives with its newline into pieces of maxLineChars", () => {
		const input = "x".repeat(100_000);
		const seen = split(16_000, `${input}\n`);
		expect(seen).toHaveLength(Math.ceil(100_000 / 16_000));
		expect(seen.every((line) => line.length <= 16_000)).toBe(true);
		expect(seen.join("")).toBe(input);
	});

	it("splits a long line that ends in a later chunk into pieces of maxLineChars", () => {
		const input = "a".repeat(30_000) + "b".repeat(30_000);
		const seen = split(16_000, input.slice(0, 30_000), `${input.slice(30_000)}\n`);
		expect(seen).toHaveLength(Math.ceil(60_000 / 16_000));
		expect(seen.every((line) => line.length <= 16_000)).toBe(true);
		expect(seen.join("")).toBe(input);
	});

	it("holds an incomplete line until a break arrives, then emits it joined", () => {
		const seen: string[] = [];
		const splitter = new LineSplitter(100, (line) => seen.push(line));
		splitter.push("half");
		expect(seen).toHaveLength(0);
		splitter.push("-done\n");
		expect(seen[0]).toBe("half-done");
	});

	it("drops blank lines", () => {
		const seen: string[] = [];
		new LineSplitter(10, (line) => seen.push(line)).push("\n\n\n");
		expect(seen).toHaveLength(0);
	});
});

describe("sanitizing", () => {
	it("strips ANSI colors and OSC sequences", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
		expect(stripAnsi("\u001b]0;title\u0007ok")).toBe("ok");
	});

	it("strips control bytes and keeps tabs", () => {
		expect(sanitizeLine("a\u0000b\u0007c")).toBe("abc");
		expect(sanitizeLine("a\tb")).toBe("a\tb");
	});

	it("clampText marks how much it cut", () => {
		expect(clampText("abcdef", 3)).toBe("abc …(+3 chars)");
	});
});

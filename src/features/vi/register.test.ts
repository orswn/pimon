import { describe, expect, it } from "vite-plus/test";
import { capturePastes, createClipboardMirror, expandMarkers, resolvePastes } from "./register.ts";

describe("expandMarkers", () => {
	it("expands known markers and keeps unknown ones", () => {
		const pastes = new Map([[1, "BODY"]]);
		expect(expandMarkers("a [paste #1 +12 lines] [paste #2 9 chars]", pastes)).toBe("a BODY [paste #2 9 chars]");
	});
});

describe("register paste contents", () => {
	const text = "a [paste #1 +12 lines] [paste #2 9 chars] [paste #3 +2 lines]";
	const captured = capturePastes(
		{ text, linewise: false },
		new Map([
			[1, "ONE"],
			[2, "TWO"],
			[4, "FOUR"],
		]),
	);

	it("keeps the content of each known marker in the text", () => {
		expect(captured.pastes).toEqual(
			new Map([
				[1, "ONE"],
				[2, "TWO"],
			]),
		);
	});

	it("keeps a marker whose paste is unchanged and puts the content of a changed one", () => {
		const resolved = resolvePastes(
			captured,
			new Map([
				[1, "ONE"],
				[2, "NEW"],
			]),
		);
		expect(resolved.text).toBe("a [paste #1 +12 lines] TWO [paste #3 +2 lines]");
	});

	it("puts every stored content when the pastes are gone", () => {
		expect(resolvePastes(captured, new Map()).text).toBe("a ONE TWO [paste #3 +2 lines]");
	});

	it("leaves a register without markers as it is", () => {
		const plain = capturePastes({ text: "abc", linewise: true }, new Map([[1, "ONE"]]));
		expect(plain).toEqual({ text: "abc", linewise: true });
		expect(resolvePastes(plain, new Map())).toBe(plain);
	});
});

describe("clipboard mirror", () => {
	it("copies only the latest text while a copy runs", async () => {
		const copies: string[] = [];
		let release: () => void = () => {};
		const copy = (text: string) => {
			copies.push(text);
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const mirror = createClipboardMirror(copy, () => {});
		mirror.mirror("one");
		mirror.mirror("two");
		mirror.mirror("three");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		await mirror.idle();
		expect(copies).toEqual(["one", "three"]);
	});

	it("warns once and keeps trying", async () => {
		const warnings: string[] = [];
		let calls = 0;
		const mirror = createClipboardMirror(
			async () => {
				calls++;
				throw new Error("no clipboard tool");
			},
			(message) => warnings.push(message),
		);
		mirror.mirror("a");
		await mirror.idle();
		mirror.mirror("b");
		await mirror.idle();
		expect(calls).toBe(2);
		expect(warnings).toEqual(["vi: clipboard copy failed: no clipboard tool"]);
	});
});

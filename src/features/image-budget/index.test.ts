import { describe, expect, it } from "vite-plus/test";
import { shouldWarnStuck } from "./index.ts";

describe("shouldWarnStuck", () => {
	it("warns the first time, then only after 4 MB more growth", () => {
		expect(shouldWarnStuck(30_000_000, 0)).toBe(true);
		expect(shouldWarnStuck(30_500_000, 30_000_000)).toBe(false);
		expect(shouldWarnStuck(33_999_999, 30_000_000)).toBe(false);
		expect(shouldWarnStuck(34_000_000, 30_000_000)).toBe(true);
	});
});

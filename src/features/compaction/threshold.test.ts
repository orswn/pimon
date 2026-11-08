import { describe, expect, it } from "vite-plus/test";
import { compactionThreshold, missingOverrides, overrideCandidates, warningText } from "./threshold.ts";

const defaults = { enabled: true, reserveTokens: 16_384 };
const big = { provider: "proxy", id: "big", contextWindow: 1_000_000 };
const small = { provider: "proxy", id: "small", contextWindow: 272_000 };

describe("compactionThreshold", () => {
	it("subtracts the default reserve when settings are empty", () => {
		expect(compactionThreshold(big, undefined, defaults)).toEqual({
			key: "proxy/big",
			enabled: true,
			threshold: 983_616,
			hasOverride: false,
		});
	});

	it("prefers the model override over the global reserve", () => {
		const settings = { reserveTokens: 64_000, modelOverrides: { "proxy/big": { reserveTokens: 744_000 } } };
		expect(compactionThreshold(big, settings, defaults)).toMatchObject({ threshold: 256_000, hasOverride: true });
		expect(compactionThreshold(small, settings, defaults)).toMatchObject({ threshold: 208_000, hasOverride: false });
	});

	it("does not count an override without reserveTokens", () => {
		const settings = { modelOverrides: { "proxy/big": { keepRecentTokens: 1 } } };
		expect(compactionThreshold(big, settings, defaults).hasOverride).toBe(false);
	});

	it("reads the enabled switch", () => {
		expect(compactionThreshold(big, { enabled: false }, defaults).enabled).toBe(false);
	});
});

describe("missingOverrides", () => {
	it("lists only models above the limit without an override", () => {
		const other = { provider: "proxy", id: "covered", contextWindow: 1_048_576 };
		const settings = { reserveTokens: 64_000, modelOverrides: { "proxy/covered": { reserveTokens: 792_576 } } };
		expect(missingOverrides([big, small, other], settings, defaults, 256_000)).toEqual({
			"proxy/big": { reserveTokens: 744_000 },
		});
	});
});

describe("warningText", () => {
	it("names the model, its threshold, and the override to add", () => {
		expect(warningText(big, 936_000, 256_000)).toBe(
			'compaction: proxy/big compacts at 936000 tokens. Add "compaction.modelOverrides": { "proxy/big": { "reserveTokens": 744000 } } to settings.json to compact at 256000.',
		);
	});
});

describe("overrideCandidates", () => {
	it("adds the current model once when it is not available", () => {
		expect(overrideCandidates([small], big)).toEqual([small, big]);
		expect(overrideCandidates([small, big], { ...big })).toEqual([small, big]);
		expect(overrideCandidates([small], undefined)).toEqual([small]);
	});
});

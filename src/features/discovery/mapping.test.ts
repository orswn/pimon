import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { discoveryEndpoint, parseJsonWithComments } from "./index.ts";
import { mapCost, mapRawItemToModel, thinkingLevelMapFromTiers } from "./mapping.ts";

const provider = { api: "openai-responses", compat: { supportsStore: false } };

const builtin = {
	id: "known",
	name: "Known Model",
	api: "anthropic-messages",
	provider: "proxy",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
	thinkingLevelMap: { off: "off", high: "high" },
	compat: { a: 1 },
} as unknown as Model<Api>;

describe("mapRawItemToModel", () => {
	it("fills a known id from the builtin catalog", () => {
		const model = mapRawItemToModel({ id: "known", compat: { b: 2 } }, provider, new Map([["known", builtin]]));
		expect(model).toEqual({
			id: "known",
			name: "Known Model",
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			thinkingLevelMap: { off: "off", high: "high" },
			compat: { a: 1, b: 2 },
		});
	});

	it("maps effort tiers to a thinking level map", () => {
		const model = mapRawItemToModel(
			{ id: "new", capabilities: { reasoning: true, effort_tiers: ["none", "low", "xhigh"] } },
			provider,
			new Map(),
		);
		expect(model).toMatchObject({
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null },
			compat: { supportsStore: false },
			contextWindow: 128_000,
			maxTokens: 16_384,
			input: ["text"],
		});
	});

	it("reads vision, limits, and pricing of an unknown id", () => {
		const model = mapRawItemToModel(
			{
				id: "priced",
				context_window: 1_000_000,
				max_output_tokens: 100_000,
				input: ["text", "image"],
				pricing: { input: 1, output: 2, cached: 0.1, long_context: { threshold: 272_000, input: 2 } },
			},
			provider,
			new Map(),
		);
		expect(model).toMatchObject({
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 100_000,
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 0,
				tiers: [{ inputTokensAbove: 272_000, input: 2, output: 2, cacheRead: 0.1, cacheWrite: 0 }],
			},
		});
	});

	it("gives an unpriced id zero cost, with no built-in price table", () => {
		expect(mapRawItemToModel({ id: "work/tier-0" }, provider, new Map()).cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});

describe("mapping helpers", () => {
	it("returns no thinking map without tiers", () => {
		expect(thinkingLevelMapFromTiers(undefined)).toBeUndefined();
		expect(thinkingLevelMapFromTiers([])).toBeUndefined();
	});

	it("ignores a non-object cost", () => {
		expect(mapCost("free")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("strips comments outside strings", () => {
		expect(parseJsonWithComments('{ /* x */ "a": "http://b//c" // y\n}')).toEqual({ a: "http://b//c" });
	});

	it("builds the endpoint from baseUrl, path, or an explicit endpoint", () => {
		expect(discoveryEndpoint({ dynamicDiscovery: true }, "http://h/v1/")).toBe("http://h/v1/models");
		expect(discoveryEndpoint({ dynamicDiscovery: { path: "/catalog" } }, "http://h")).toBe("http://h/catalog");
		expect(discoveryEndpoint({ baseUrl: "http://cfg", dynamicDiscovery: true }, undefined)).toBe("http://cfg/models");
		expect(discoveryEndpoint({ dynamicDiscovery: { endpoint: "http://x/m" } }, "http://h")).toBe("http://x/m");
	});
});

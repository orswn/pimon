import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { compaction } from "../../src/features/compaction/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

const fauxModels = [
	{ id: "big", contextWindow: 1_000_000 },
	{ id: "small", contextWindow: 200_000 },
];

const keyless = defineFeature({
	id: "keyless",
	description: "test provider whose API key env var is not set",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.registerProvider("keyless", {
			baseUrl: "http://127.0.0.1:9",
			api: "openai-completions",
			apiKey: "$PIMON_TEST_UNSET_KEY",
			models: [
				{
					id: "huge",
					name: "huge",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 2_000_000,
					maxTokens: 1000,
				},
			],
		});
	},
});

const warnings = (harness: Harness) => harness.notifications.filter((note) => note.level === "warning");

async function start(settings: HarnessOptions["settings"]): Promise<Harness> {
	return createHarness({ features: [compaction, keyless], fauxModels, settings, ui: {} });
}

describe("compaction warning", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("warns once per model about a late compaction threshold", async () => {
		harness = await start({ compaction: { enabled: true, reserveTokens: 64_000 } });
		const provider = harness.session.model?.provider ?? "";
		expect(warnings(harness).map((note) => note.message)).toEqual([
			`compaction: ${provider}/big compacts at 936000 tokens. Add "compaction.modelOverrides": { "${provider}/big": { "reserveTokens": 744000 } } to settings.json to compact at 256000.`,
		]);

		const big = harness.modelRuntime.getModel(provider, "big");
		const small = harness.modelRuntime.getModel(provider, "small");
		if (!big || !small) throw new Error("faux models missing");
		await harness.session.setModel(small);
		await harness.session.setModel(big);
		await harness.session.reload();
		expect(warnings(harness)).toHaveLength(1);
	});

	it("does not warn when an override covers the model", async () => {
		harness = await start({
			compaction: { enabled: true, modelOverrides: { "faux/big": { reserveTokens: 744_000 } } },
		});
		expect(harness.session.model?.provider).toBe("faux");
		expect(warnings(harness)).toEqual([]);
	});

	it("does not warn when compaction is off", async () => {
		harness = await start({ compaction: { enabled: false } });
		expect(warnings(harness)).toEqual([]);
	});

	it("prints the missing overrides for available models", async () => {
		harness = await start({ compaction: { enabled: true, reserveTokens: 64_000 } });
		await harness.session.prompt("/compaction-overrides");
		const info = harness.notifications.filter((note) => note.level === "info").map((note) => note.message);
		expect(info).toHaveLength(1);
		const printed = JSON.parse(info[0] ?? "{}") as Record<string, unknown>;
		expect(printed["faux/big"]).toEqual({ reserveTokens: 744_000 });
		expect(printed["faux/small"]).toBeUndefined();
		expect(harness.modelRuntime.getModel("keyless", "huge")).toBeDefined();
		expect(printed["keyless/huge"]).toBeUndefined();
	});
});

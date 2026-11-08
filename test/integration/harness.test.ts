import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const asks = defineFeature({
	id: "asks",
	description: "test feature that asks the human for confirmation",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.registerCommand("ask", {
			description: "ask for confirmation",
			handler: async (_args, extensionCtx) => {
				const ok = await extensionCtx.ui.confirm("title", "proceed?");
				extensionCtx.ui.notify(`answer ${String(ok)}`, "info");
			},
		});
	},
});

describe("harness recording UI", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("throws for a UI method the test did not provide", async () => {
		harness = await createHarness({ features: [asks], ui: {} });
		await harness.session.prompt("/ask");
		expect(JSON.stringify(harness.extensionErrors)).toContain("harness UI has no confirm()");
		expect(harness.notifications).toEqual([]);
	});

	it("uses a UI method the test provides", async () => {
		harness = await createHarness({ features: [asks], ui: { confirm: async () => true } });
		await harness.session.prompt("/ask");
		expect(harness.notifications).toEqual([{ message: "answer true", level: "info" }]);
	});
});

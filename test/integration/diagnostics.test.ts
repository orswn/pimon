import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let starts = 0;
const noisy = defineFeature({
	id: "noisy",
	description: "test feature that reports many diagnostics",
	defaultEnabled: true,
	setup(ctx) {
		for (let n = 0; n < 3; n++) ctx.log.warn("same");
		for (let n = 0; n < 150; n++) ctx.log.warn(`distinct ${n}`);
		ctx.onSessionStart(() => {
			starts++;
			ctx.log.warn("same");
			if (starts === 2) ctx.log.warn("late");
		});
	},
});

describe("pimon diagnostics", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		starts = 0;
	});

	it("keeps one entry per feature, level, and message, at most 100, and still announces new ones", async () => {
		harness = await createHarness({ features: [noisy], ui: {} });
		const messages = () => harness?.runtime.diagnostics().map((entry) => entry.message) ?? [];
		// The setup "same" was the oldest entry and was dropped. The first session start added it again.
		expect(messages()).toHaveLength(100);
		expect(messages().at(0)).toBe("distinct 51");
		expect(messages().at(-1)).toBe("same");

		const notices = harness.uiNotices.length;
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(messages().at(-1)).toBe("late");
		expect(messages().filter((message) => message === "same")).toEqual(["same"]);
		expect(messages()).toHaveLength(100);
		expect(messages().at(0)).toBe("distinct 52");
		const announced = harness.uiNotices.slice(notices).join("\n");
		expect(announced).toContain("noisy: late");
		expect(announced).not.toContain("distinct");
		expect(announced).not.toContain("same");
	});
});

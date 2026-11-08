import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const CHILD_TOOLS = ["read", "bash", "write", "background", "monitor", "pi_bus"];

const narrowTools = defineFeature({
	id: "narrow-tools",
	description: "test feature that keeps only a child tool allowlist",
	defaultEnabled: true,
	setup(ctx) {
		ctx.onSessionStart(() => ctx.pi.setActiveTools(CHILD_TOOLS));
	},
});

describe("prompt sections with a narrow tool allowlist", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
	});

	it("leave out the sections of tools that are not active", async () => {
		harness = await createHarness({ features: [...features, narrowTools] });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("hi");
		const system = harness.requests[0]?.find((message) => message.role === "system");
		const names = Object.keys(system?.sections ?? {});

		expect(harness.session.getActiveToolNames().sort()).toEqual([...CHILD_TOOLS].sort());
		expect(names).toEqual(expect.arrayContaining(["harness", "background", "secrets", "bus"]));
		expect(names).not.toContain("notify");
		expect(names).not.toContain("goal");
		expect(names).not.toContain("agents");
	});
});

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

describe("rendered prompt sections", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
	});

	it("matches the reviewed text for every default feature", async () => {
		harness = await createHarness({ features });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("hi");
		const system = harness.requests[0]?.find((message) => message.role === "system");
		const ours = Object.entries(system?.sections ?? {}).filter(([name]) =>
			harness?.runtime.prompts.current().some((section) => section.name === name),
		);
		expect(ours.map(([name]) => name)).toEqual(harness.runtime.prompts.current().map((section) => section.name));
		await expect(ours.map(([, text]) => text).join("\n\n")).toMatchFileSnapshot("__snapshots__/prompt-sections.md");
		expect(harness.runtime.diagnostics()).toEqual([]);
	});
});

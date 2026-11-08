import { afterEach, describe, expect, it } from "vite-plus/test";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

describe("registered tool text", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
	});

	it("matches the reviewed text for every default feature", async () => {
		harness = await createHarness({ features });
		const tools = harness.session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition);
		const text = tools
			.map((tool) =>
				[
					`## ${tool.name}`,
					"",
					`description: ${tool.description}`,
					`promptSnippet: ${tool.promptSnippet ?? ""}`,
					`promptGuidelines: ${JSON.stringify(tool.promptGuidelines ?? [])}`,
					`schema: ${JSON.stringify(tool.parameters)}`,
				].join("\n"),
			)
			.join("\n\n");
		await expect(`${text}\n`).toMatchFileSnapshot("__snapshots__/tool-surface.md");
	});
});

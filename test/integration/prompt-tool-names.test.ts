import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { delegatedPrompt } from "../../src/features/agents/prompt.ts";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

// Backticked words in the sections that are neither tools nor schema enum values.
const NOT_TOOLS = new Set(["await", "delivered", "queued", "unconfirmed", "failed"]);
// pi tools that the in-process harness does not load.
const PI_TOOLS = new Set(["codemode"]);

interface Schema {
	enum?: unknown[];
	properties?: Record<string, Schema>;
	anyOf?: Schema[];
	items?: Schema;
}

function enumValues(schema: Schema | undefined): string[] {
	if (!schema) return [];
	return [
		...(schema.enum ?? []).filter((value): value is string => typeof value === "string"),
		...Object.values(schema.properties ?? {}).flatMap(enumValues),
		...(schema.anyOf ?? []).flatMap(enumValues),
		...enumValues(schema.items),
	];
}

describe("tool names in prompt sections", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
	});

	it("name only registered tools, schema values, and actions of the named tools", async () => {
		harness = await createHarness({ features });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("hi");
		const system = harness.requests[0]?.find((message) => message.role === "system");
		const ours = new Set(
			harness.runtime.prompts.current(new Set(harness.session.getActiveToolNames())).map((section) => section.name),
		);
		const texts = Object.entries(system?.sections ?? {})
			.filter(([name]) => ours.has(name))
			.map(([, text]) => text ?? "");
		texts.push(delegatedPrompt("child", "parent", "a991cc91-6495-4c81-bd1c-03ce8d23e62d"));

		const tools = new Map(
			harness.session.getAllTools().map((tool) => [tool.name, tool.parameters as unknown as Schema] as const),
		);
		const actionsOf = (name: string) => enumValues(tools.get(name)?.properties?.["action"]);
		const allValues = new Set([...tools.values()].flatMap(enumValues));
		const allActions = new Set([...tools.keys()].flatMap(actionsOf));

		const unknownWords: string[] = [];
		const unknownActions: string[] = [];
		for (const line of texts.flatMap((text) => text.split("\n"))) {
			const words = [...line.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1] ?? "");
			for (const word of words) {
				if (tools.has(word) || PI_TOOLS.has(word) || allValues.has(word) || NOT_TOOLS.has(word)) continue;
				unknownWords.push(`${word} in: ${line}`);
			}
			const named = words.filter((word) => actionsOf(word).length > 0);
			for (const match of line.matchAll(/action="([^"]+)"/g)) {
				const action = match[1] ?? "";
				const known =
					named.length > 0 ? named.some((tool) => actionsOf(tool).includes(action)) : allActions.has(action);
				if (!known) unknownActions.push(`${action} in: ${line}`);
			}
		}
		expect(unknownWords).toEqual([]);
		expect(unknownActions).toEqual([]);
		expect(allActions.size).toBeGreaterThan(0);
	});
});

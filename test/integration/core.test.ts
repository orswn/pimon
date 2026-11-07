import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const probe = defineFeature({
	id: "probe",
	description: "test feature",
	defaultEnabled: true,
	setup(ctx) {
		ctx.promptSection({ name: "probe_rules", render: ({ cwd }) => `Probe rules for ${cwd}.` });
		ctx.pi.registerTool({
			name: "probe_echo",
			label: "Probe echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: `echo:${params.text}` }], details: {} }),
		});
	},
});

function systemMessages(messages: Message[]) {
	return messages.filter((message) => message.role === "system");
}

describe("pimon core in a real AgentSession", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.dispose());

	it("runs a feature tool through the faux model", async () => {
		harness = await createHarness({ features: [probe] });
		harness.respond([
			fauxAssistantMessage(fauxToolCall("probe_echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt("call the probe");
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "probe_echo", isError: false });
		expect(JSON.stringify(toolResult)).toContain("echo:hi");
		expect(harness.runtime.status()).toEqual([{ id: "probe", state: "enabled", config: {} }]);
	});

	it("declares prompt sections once, after the addendum, and never patches them", async () => {
		harness = await createHarness({ features: [probe], appendSystemPrompt: ["ADDENDUM TEXT"] });
		harness.respond([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.requests).toHaveLength(2);
		const [first, second] = harness.requests;
		const head = systemMessages(first ?? []);
		expect(head).toHaveLength(1);
		const names = Object.keys(head[0]?.sections ?? {});
		expect(names.indexOf("probe_rules")).toBeGreaterThan(names.indexOf("addendum"));
		expect(head[0]?.sections?.["probe_rules"]).toBe(`<probe_rules>\nProbe rules for ${harness.cwd}.\n</probe_rules>`);
		expect(systemMessages(second ?? [])).toHaveLength(1);
	});
});

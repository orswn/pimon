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

	it("renders a tool-gated section only when a required tool is active at first render", async () => {
		const gated = defineFeature({
			id: "gated",
			description: "test feature with tool-gated sections",
			defaultEnabled: true,
			setup(ctx) {
				ctx.promptSection({ name: "with_echo", requiresTools: ["probe_echo"], render: () => "Echo rules." });
				ctx.promptSection({ name: "with_missing", requiresTools: ["no_such_tool"], render: () => "Missing." });
				ctx.onSessionStart(() => {
					if (process.env["PIMON_TEST_DROP_ECHO"] === "1")
						ctx.pi.setActiveTools(ctx.pi.getActiveTools().filter((name) => name !== "probe_echo"));
				});
			},
		});
		const sectionsOf = async () => {
			harness = await createHarness({ features: [probe, gated] });
			harness.respond([fauxAssistantMessage(fauxText("one"))]);
			await harness.session.prompt("first");
			const names = Object.keys(systemMessages(harness.requests[0] ?? [])[0]?.sections ?? {});
			harness.dispose();
			harness = undefined;
			return names;
		};

		const active = await sectionsOf();
		expect(active).toContain("with_echo");
		expect(active).not.toContain("with_missing");

		process.env["PIMON_TEST_DROP_ECHO"] = "1";
		try {
			const inactive = await sectionsOf();
			expect(inactive).not.toContain("with_echo");
			expect(inactive).toContain("probe_rules");
		} finally {
			delete process.env["PIMON_TEST_DROP_ECHO"];
		}
	});
});

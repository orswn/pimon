import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/** The sections the model has after the first system message and its later patches. */
function liveSections(messages: Message[]): Record<string, string> {
	const live: Record<string, string> = {};
	for (const message of systemMessages(messages)) {
		for (const [name, text] of Object.entries(message.sections ?? {})) {
			if (text === null) delete live[name];
			else live[name] = text;
		}
	}
	return live;
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

	it("applies a tool-gated section only while a required tool is active", async () => {
		let pi: ExtensionAPI | undefined;
		const gated = defineFeature({
			id: "gated",
			description: "test feature with tool-gated sections",
			defaultEnabled: true,
			setup(ctx) {
				pi = ctx.pi;
				ctx.promptSection({ name: "with_echo", requiresTools: ["probe_echo"], render: () => "Echo rules." });
				ctx.promptSection({ name: "with_missing", requiresTools: ["no_such_tool"], render: () => "Missing." });
			},
		});
		harness = await createHarness({ features: [probe, gated] });
		harness.respond([
			fauxAssistantMessage(fauxText("one")),
			fauxAssistantMessage(fauxText("two")),
			fauxAssistantMessage(fauxText("three")),
		]);
		const sectionsOf = (index: number) => liveSections(harness?.requests[index] ?? []);

		await harness.session.prompt("first");
		const all = pi?.getActiveTools() ?? [];
		pi?.setActiveTools(all.filter((name) => name !== "probe_echo"));
		await harness.session.prompt("second");
		pi?.setActiveTools(all);
		await harness.session.prompt("third");

		expect(Object.keys(sectionsOf(0))).toContain("with_echo");
		expect(Object.keys(sectionsOf(0))).not.toContain("with_missing");
		expect(Object.keys(sectionsOf(1))).not.toContain("with_echo");
		expect(Object.keys(sectionsOf(1))).toContain("probe_rules");
		expect(sectionsOf(2)["with_echo"]).toBe(sectionsOf(0)["with_echo"]);
		expect(sectionsOf(2)["with_echo"]).toBe("<with_echo>\nEcho rules.\n</with_echo>");
	});

	it("adds a section when its tool becomes active after session start", async () => {
		let pi: ExtensionAPI | undefined;
		const gated = defineFeature({
			id: "gated",
			description: "test feature that drops its tool at session start",
			defaultEnabled: true,
			setup(ctx) {
				pi = ctx.pi;
				ctx.promptSection({ name: "with_echo", requiresTools: ["probe_echo"], render: () => "Echo rules." });
				ctx.onSessionStart(() =>
					ctx.pi.setActiveTools(ctx.pi.getActiveTools().filter((name) => name !== "probe_echo")),
				);
			},
		});
		harness = await createHarness({ features: [probe, gated] });
		harness.respond([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
		await harness.session.prompt("first");
		pi?.setActiveTools([...(pi?.getActiveTools() ?? []), "probe_echo"]);
		await harness.session.prompt("second");

		const sectionsOf = (index: number) => liveSections(harness?.requests[index] ?? []);
		expect(Object.keys(sectionsOf(0))).not.toContain("with_echo");
		expect(sectionsOf(1)["with_echo"]).toBe("<with_echo>\nEcho rules.\n</with_echo>");
	});
});

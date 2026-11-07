import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { imageBudget } from "../../src/features/image-budget/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const screenshot = defineFeature({
	id: "screenshot",
	description: "test tool that returns an image",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.registerTool({
			name: "shot",
			label: "Shot",
			description: "Return an image",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id, params) => ({
				content: [
					{ type: "text", text: `image ${params.path}` },
					{ type: "image", mimeType: "image/png", data: "A".repeat(2_000) },
				],
				details: {},
			}),
		});
	},
});

const shot = (path: string) => fauxAssistantMessage(fauxToolCall("shot", { path }), { stopReason: "toolUse" });
const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "image" ? "IMAGE" : block.text)).join(" | "));

describe("image-budget in a session", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.dispose());

	it("replaces old tool-result images once the context passes the trigger", async () => {
		harness = await createHarness({
			features: [screenshot, imageBudget],
			setupAgentDir: (dir) => {
				writeFileSync(
					join(dir, "pimon.json"),
					JSON.stringify({
						features: { "image-budget": { triggerBytes: 5_000, targetBytes: 3_000, keepRecentImages: 1 } },
					}),
				);
			},
		});
		harness.respond([shot("/a.png"), shot("/b.png"), shot("/c.png"), fauxAssistantMessage(fauxText("done"))]);
		await harness.session.prompt("take three shots");

		expect(harness.runtime.diagnostics()).toEqual([]);
		const last = toolTexts(harness.requests.at(-1));
		expect(last).toHaveLength(3);
		expect(last[0]).toContain("Path: /a.png.");
		expect(last[0]).not.toContain("IMAGE");
		expect(last[2]).toBe("image /c.png | IMAGE");
		const edits = harness.session.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
		expect(edits.length).toBeGreaterThan(0);
	});

	it("rejects a target that is not below the trigger", async () => {
		harness = await createHarness({
			features: [imageBudget],
			setupAgentDir: (dir) => {
				writeFileSync(
					join(dir, "pimon.json"),
					JSON.stringify({ features: { "image-budget": { triggerBytes: 10, targetBytes: 10 } } }),
				);
			},
		});
		expect(harness.runtime.status()).toEqual([
			{ id: "image-budget", state: "failed", reason: "targetBytes (10) must be below triggerBytes (10)" },
		]);
	});
});

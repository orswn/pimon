import { fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const created: object[] = [];

const keeper = defineFeature({
	id: "keeper",
	description: "test feature with reload state",
	defaultEnabled: true,
	setup(ctx) {
		created.push(ctx.reloadState("jobs", 1, () => ({ born: created.length })));
		ctx.promptSection({ name: "keeper", render: () => "Static keeper text." });
	},
});

const systemCount = (messages: Message[] | undefined) =>
	(messages ?? []).filter((message) => message.role === "system").length;

describe("reload", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.dispose();
		created.length = 0;
		clearReloadState();
	});

	it.each([true, false])("keeps reload state and sends no prompt patch (host bindings: %s)", async (hostBindings) => {
		harness = await createHarness({ features: [keeper], hostBindings });
		harness.respond([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
		await harness.session.prompt("before reload");
		await harness.session.reload();
		await harness.session.prompt("after reload");

		expect(created).toHaveLength(2);
		expect(created[1]).toBe(created[0]);
		expect(systemCount(harness.requests[1])).toBe(1);
		expect(harness.extensionErrors).toEqual([]);
	});
});

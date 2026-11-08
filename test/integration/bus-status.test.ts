import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus, type BusService } from "../../src/features/bus/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let service: BusService | undefined;
const capture = defineFeature({
	id: "bus-capture",
	description: "test feature that captures the bus service",
	defaultEnabled: true,
	dependsOn: ["bus"],
	setup(ctx) {
		service = ctx.service("bus");
	},
});

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("bus status line", () => {
	let harness: Harness | undefined;
	beforeEach(() => {
		clearReloadState();
	});
	afterEach(async () => {
		service = undefined;
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("sends the status text only when it changed, and again after a session start", async () => {
		const sent: string[] = [];
		harness = await createHarness({
			features: [bus, capture],
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					if (key === "pi-bus") sent.push(text ?? "");
				},
			},
		});
		const h = harness;
		await until(() => service?.started === true && sent.length > 0);
		expect(sent).toEqual(["bus: 0 peers"]);

		h.respond([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		expect(sent).toEqual(["bus: 0 peers"]);

		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(sent).toEqual(["bus: 0 peers", "bus: 0 peers"]);
	});
});

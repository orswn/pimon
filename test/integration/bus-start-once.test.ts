import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("bus start after a failure", () => {
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

	it("tries once per session start, not again on each prompt", async () => {
		harness = await createHarness({
			features: [bus, capture],
			ui: {},
			setupAgentDir: (agentDir) => writeFileSync(join(agentDir, "bus"), "not a dir"),
		});
		const h = harness;
		const failures = () => h.notifications.filter((entry) => entry.message.startsWith("pi-bus failed to start")).length;
		const busDiagnostics = () => h.runtime.diagnostics().filter((entry) => entry.feature === "bus").length;
		await until(() => failures() === 1);
		expect(busDiagnostics()).toBe(1);

		h.respond([
			fauxAssistantMessage(fauxText("a")),
			fauxAssistantMessage(fauxText("b")),
			fauxAssistantMessage(fauxText("c")),
		]);
		for (const text of ["one", "two", "three"]) await h.session.prompt(text);
		expect(h.requests).toHaveLength(3);
		expect(failures()).toBe(1);
		expect(busDiagnostics()).toBe(1);

		rmSync(join(h.agentDir, "bus"));
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		await until(() => service?.started === true);
		expect(failures()).toBe(1);
	});

	it("starts the bus at the first prompt when a reload sends no session start", async () => {
		harness = await createHarness({ features: [bus, capture], hostBindings: false });
		const h = harness;
		h.respond([fauxAssistantMessage(fauxText("a"))]);
		await h.session.reload();
		expect(service?.started).toBe(false);

		await h.session.prompt("one");
		expect(service?.started).toBe(true);
	});
});

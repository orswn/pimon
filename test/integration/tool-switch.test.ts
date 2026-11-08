import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

describe("tools switch in pimon.json", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
	});

	const start = (tools: Record<string, unknown>) =>
		createHarness({
			features,
			setupAgentDir: (dir) => writeFileSync(join(dir, "pimon.json"), JSON.stringify({ tools })),
		});

	it("does not register a tool that is off, and drops its gated section", async () => {
		harness = await start({ notify: false, background_codemode: false, timer: true });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("hi");
		const names = harness.session.getAllTools().map((tool) => tool.name);
		expect(names).not.toContain("notify");
		expect(names).not.toContain("background_codemode");
		expect(names).toEqual(expect.arrayContaining(["timer", "monitor_codemode", "background", "pi_bus"]));
		const system = harness.requests[0]?.find((message) => message.role === "system");
		const sections = Object.keys(system?.sections ?? {});
		expect(sections).not.toContain("notify");
		expect(sections).toEqual(expect.arrayContaining(["background", "bus"]));
		expect(harness.runtime.diagnostics().map((entry) => entry.message)).toEqual([
			expect.stringMatching(/tools\.notify is off, but goal_done needs it$/) as string,
		]);
	});

	it("warns when a tool that is on needs a tool that is off", async () => {
		harness = await start({ pi_bus: false });
		expect(harness.runtime.diagnostics().map((entry) => entry.message)).toEqual([
			expect.stringMatching(/pimon\.json: tools\.pi_bus is off, but pi_agents needs it$/) as string,
		]);
	});

	it("leaves out the timer and codemode lines when those tools are off", async () => {
		harness = await start({ timer: false, background_codemode: false, monitor_codemode: false });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt("hi");
		const system = harness.requests[0]?.find((message) => message.role === "system");
		const sections = system?.sections ?? {};
		expect(Object.keys(sections)).not.toContain("timer");
		expect(Object.keys(sections)).not.toContain("scripts");
		expect(JSON.stringify(sections)).not.toContain("_codemode");
		expect(sections["background"]).not.toContain("timer");
		expect(harness.runtime.diagnostics().map((entry) => entry.message)).toEqual([
			expect.stringMatching(/tools\.timer is off, but goal_done needs it$/) as string,
		]);
	});

	it("warns about a name that no enabled feature registers", async () => {
		harness = await start({ nosuch: false, background_codemode: false });
		expect(harness.runtime.diagnostics()).toEqual([
			{
				feature: "pimon",
				level: "warning",
				message: expect.stringMatching(/pimon\.json: tools\.nosuch is not a tool of an enabled feature$/) as string,
			},
		]);
	});
});

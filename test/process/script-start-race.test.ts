import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createRegistry, type Registry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";
import { createEngineCache } from "../../src/features/background/script-engine.ts";
import { runningScripts, startScriptJob } from "../../src/features/background/scripts.ts";

const ctx = { cwd: process.cwd(), tools: [], executeTool: async () => ({}) } as unknown as ExtensionToolContext;
const code = "for (;;) { await sleep(50); }";
const registries: Registry[] = [];

function fresh(): Registry {
	const reg = createRegistry("");
	registries.push(reg);
	return reg;
}

afterEach(async () => {
	for (const reg of registries.splice(0)) await shutdownJobs(reg);
});

describe("parallel script starts with a cold engine", () => {
	it("refuses the fifth of 5 parallel starts with a cap of 4", async () => {
		const reg = fresh();
		const engine = createEngineCache();
		const results = await Promise.allSettled(
			[1, 2, 3, 4, 5].map((n) =>
				startScriptJob("background", { code, name: `j${n}` }, { reg, maxScriptJobs: 4, ctx, engine }),
			),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
		const refused = results.filter((result) => result.status === "rejected");
		expect(refused).toHaveLength(1);
		expect(String((refused[0] as PromiseRejectedResult).reason)).toContain("Too many script jobs: 4 of 4 run now");
		expect(runningScripts(reg)).toHaveLength(4);
	});

	it("starts only one of 2 parallel starts with the same name", async () => {
		const reg = fresh();
		const engine = createEngineCache();
		const results = await Promise.allSettled(
			[1, 2].map(() => startScriptJob("background", { code, name: "same" }, { reg, maxScriptJobs: 4, ctx, engine })),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(runningScripts(reg)).toHaveLength(1);
	});
});

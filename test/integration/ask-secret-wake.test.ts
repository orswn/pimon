import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseStep, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { defineFeature, type FeatureContext } from "../../src/core/feature.ts";
import { clearReloadState, reloadSlot } from "../../src/core/reload-state.ts";
import { createAskSecret } from "../../src/features/ask-secret/index.ts";
import { background } from "../../src/features/background/index.ts";
import { createRegistry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const SECRET = "wake-s3cr3t-value";
const askSecret = createAskSecret({ alert: () => {} });

const stateRoot = mkdtempSync(join(tmpdir(), "pimon-ask-secret-wake-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
beforeAll(() => {
	process.env["PI_BACKGROUND_DIR"] = stateRoot;
});
afterAll(() => {
	if (savedDir === undefined) delete process.env["PI_BACKGROUND_DIR"];
	else process.env["PI_BACKGROUND_DIR"] = savedDir;
	rmSync(stateRoot, { recursive: true, force: true });
});

const say = (text: string) => fauxAssistantMessage(fauxText(text));
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const customEntries = (harness: Harness, customType: string) =>
	harness.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === customType);

describe("ask-secret redacts wakes", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await shutdownJobs(reloadSlot("background", "registry", 1, () => createRegistry("")));
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("redacts a secret that a fast background job prints in its inline digest", async () => {
		harness = await createHarness({ features: [askSecret, background] });
		harness.respond([
			call("background", { action: "start", name: "leak", command: 'echo "got $PI_SECRET_DB"' }),
			say("saw the digest"),
		]);
		await harness.session.prompt(`run it with [[secret DB:${SECRET}]]`);
		await harness.waitForRequests(2);
		await harness.session.waitForIdle();

		const result = JSON.stringify(harness.requests[1]);
		expect(result).toContain('Background job \\"leak\\" ended');
		expect(result).toContain("got $PI_SECRET_DB");
		expect(result).not.toContain(SECRET);
		expect(customEntries(harness, "background")).toEqual([]);
		expect(JSON.stringify(harness.session.sessionManager.getEntries())).not.toContain(SECRET);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("redacts a secret that a background job prints in its exit digest", async () => {
		harness = await createHarness({
			features: [askSecret, background],
			setupAgentDir: (dir) =>
				writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { background: { inlineWaitMs: 0 } } })),
		});
		harness.respond([
			call("background", { action: "start", name: "leak", command: 'echo "got $PI_SECRET_DB"' }),
			say("started"),
			say("saw the digest"),
		]);
		await harness.session.prompt(`run it with [[secret DB:${SECRET}]]`);
		await harness.waitForRequests(3);
		await harness.session.waitForIdle();

		const woken = JSON.stringify(harness.requests[2]);
		expect(woken).toContain("got $PI_SECRET_DB");
		expect(woken).not.toContain(SECRET);
		const digests = customEntries(harness, "background");
		expect(digests).toHaveLength(1);
		expect(JSON.stringify(digests)).toContain("got $PI_SECRET_DB");
		expect(JSON.stringify(harness.session.sessionManager.getEntries())).not.toContain(SECRET);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("redacts a wake that was held during a manual compaction", async () => {
		let waker: FeatureContext<unknown> | undefined;
		const probe = defineFeature({
			id: "probe",
			description: "test feature that wakes the model",
			defaultEnabled: true,
			setup(ctx) {
				waker = ctx as FeatureContext<unknown>;
			},
		});
		harness = await createHarness({ features: [askSecret, probe] });
		let compactionStarted = () => {};
		const started = new Promise<void>((resolve) => (compactionStarted = resolve));
		let releaseSummary = () => {};
		const summaryGate = new Promise<void>((resolve) => (releaseSummary = resolve));
		const heldSummary: FauxResponseStep = async () => {
			compactionStarted();
			await summaryGate;
			return say("SUMMARY");
		};
		harness.respond([say("R1"), say("R2"), heldSummary, say("WOKE")]);
		await harness.session.prompt(`keep [[secret DB:${SECRET}]] ${"x".repeat(100_000)}`);
		await harness.session.prompt(`more ${"y".repeat(100_000)}`);

		const compacting = harness.session.compact();
		await started;
		waker?.wake({
			customType: "probe",
			content: [{ type: "text", text: `held ${SECRET}` }],
			display: true,
			details: { nested: [SECRET] },
		});
		await sleep(50);
		releaseSummary();
		await compacting;
		await harness.waitForRequests(4);
		await harness.session.waitForIdle();

		const woken = JSON.stringify(harness.requests[3]);
		expect(woken).toContain("held $PI_SECRET_DB");
		expect(woken).not.toContain(SECRET);
		const entries = customEntries(harness, "probe");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ details: { nested: ["$PI_SECRET_DB"] } });
		expect(JSON.stringify(entries)).not.toContain(SECRET);
	});
});

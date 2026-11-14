import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus } from "../../src/features/bus/index.ts";
import { busCapture, until } from "../support/bus.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { startTestHub, type TestHub, writeHubConfig } from "../support/hub.ts";

const capture = busCapture();

describe("bus start and hub reachability", () => {
	let harness: Harness | undefined;
	let hub: TestHub | undefined;
	beforeEach(() => {
		clearReloadState();
	});
	afterEach(async () => {
		capture.reset();
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		await hub?.close();
		hub = undefined;
		clearReloadState();
	});

	it("refuses a token file that others can read, once per session start, not again on each prompt", async () => {
		hub = await startTestHub();
		const url = hub.url;
		harness = await createHarness({
			features: [bus, capture.feature],
			ui: {},
			setupAgentDir: (agentDir) => {
				writeHubConfig(agentDir, url);
				chmodSync(join(agentDir, "pimon-hub.token"), 0o644);
			},
		});
		const h = harness;
		const failures = () => h.notifications.filter((entry) => entry.message.includes("mode 0600")).length;
		await until(() => failures() === 1);
		expect(capture.get().started).toBe(false);

		h.respond([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))]);
		for (const text of ["one", "two"]) await h.session.prompt(text);
		expect(failures()).toBe(1);
		expect(await hub.agents(true)).toEqual([]);

		chmodSync(join(h.agentDir, "pimon-hub.token"), 0o600);
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		await until(() => capture.get().online);
		expect(failures()).toBe(1);
	});

	it("starts the bus at the first prompt when a reload sends no session start", async () => {
		hub = await startTestHub();
		const url = hub.url;
		harness = await createHarness({
			features: [bus, capture.feature],
			hostBindings: false,
			setupAgentDir: (agentDir) => writeHubConfig(agentDir, url),
		});
		const h = harness;
		h.respond([fauxAssistantMessage(fauxText("a"))]);
		await h.session.reload();
		expect(capture.get().started).toBe(false);

		await h.session.prompt("one");
		expect(capture.get().started).toBe(true);
	});

	it("warns once while the hub is down and links when it is back", async () => {
		hub = await startTestHub();
		const { url } = hub;
		await hub.stop();
		harness = await createHarness({
			features: [bus, capture.feature],
			ui: {},
			setupAgentDir: (agentDir) => writeHubConfig(agentDir, url),
		});
		const h = harness;
		await until(() => h.notifications.some((entry) => entry.message.includes("unreachable, retrying")));
		await h.session.prompt("/bus");
		expect(h.notifications.at(-1)?.message.split("\n")[0]).toBe("bus: hub offline");

		await hub.restart();
		await until(() => capture.get().online, 10_000);
		expect(h.notifications.filter((entry) => entry.message.includes("unreachable, retrying"))).toHaveLength(1);
		expect(h.notifications.some((entry) => entry.message.includes("is reachable again"))).toBe(true);
		expect(h.requests).toHaveLength(0);
	});

	it("shows a short link drop only in the status, without a warning", async () => {
		hub = await startTestHub();
		const { url } = hub;
		harness = await createHarness({
			features: [bus, capture.feature],
			ui: {},
			setupAgentDir: (agentDir) => writeHubConfig(agentDir, url),
		});
		const h = harness;
		await until(() => capture.get().online, 10_000);
		await hub.restart();
		await until(() => !capture.get().online, 5_000);
		await until(() => capture.get().online, 10_000);
		expect(h.notifications.filter((entry) => entry.message.includes("unreachable"))).toEqual([]);
		expect(h.notifications.filter((entry) => entry.message.includes("reachable again"))).toEqual([]);
	});

	it("warns once after three failed attempts of a link that was online", async () => {
		hub = await startTestHub();
		const { url } = hub;
		harness = await createHarness({
			features: [bus, capture.feature],
			ui: {},
			setupAgentDir: (agentDir) => writeHubConfig(agentDir, url),
		});
		const h = harness;
		await until(() => capture.get().online, 10_000);
		await hub.close();
		hub = undefined;
		await until(() => !capture.get().online, 5_000);
		const warnings = () => h.notifications.filter((entry) => entry.message.includes("unreachable, retrying"));
		// The backoff waits 1 s and then 2 s before the third attempt.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(warnings()).toEqual([]);
		await until(() => warnings().length > 0, 15_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(warnings()).toHaveLength(1);
	}, 30_000);
});

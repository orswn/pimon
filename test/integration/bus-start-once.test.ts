import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus } from "../../src/features/bus/index.ts";
import { busCapture, until } from "../support/bus.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { HOST_TOKEN, startTestHub, TEST_TOKEN_FILE, tempDir, type TestHub, writeHubConfig } from "../support/hub.ts";

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
				chmodSync(join(agentDir, TEST_TOKEN_FILE), 0o644);
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

		chmodSync(join(h.agentDir, TEST_TOKEN_FILE), 0o600);
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		await until(() => capture.get().online);
		expect(failures()).toBe(1);
	});

	it("stops with an upgrade text and no retry when the hub speaks protocol 2", async () => {
		const requests: { method: string; url: string; body: string }[] = [];
		const old = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				requests.push({ method: req.method ?? "", url: req.url ?? "", body });
				res.writeHead(426, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "hub protocol 2 required", expected: 2 }));
			});
		});
		await new Promise<void>((done) => old.listen(0, "127.0.0.1", done));
		try {
			const url = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
			harness = await createHarness({
				features: [bus, capture.feature],
				setupAgentDir: (agentDir) => writeHubConfig(agentDir, url),
			});
			await until(() => capture.get().unavailable()?.includes("426") === true);
			expect(capture.get().unavailable()).toBe(
				"pi_bus: 426 hub protocol 2 required. This pimon speaks hub protocol 3. Update pimon or the hub.",
			);
			expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ protocol: 3, labels: { harness: "pi" } });
		} finally {
			await harness?.shutdown();
			harness?.dispose();
			harness = undefined;
			old.closeAllConnections();
			await new Promise<void>((done) => old.close(() => done()));
		}
	});

	it("reads the host token file of a2a-hub clients when hub.tokenFile is not set", async () => {
		hub = await startTestHub();
		const url = hub.url;
		const home = tempDir("pimon-home-");
		const savedHome = process.env["HOME"];
		process.env["HOME"] = home.dir;
		try {
			mkdirSync(join(home.dir, ".config", "a2a"), { recursive: true });
			writeFileSync(join(home.dir, ".config", "a2a", "host.token"), `${HOST_TOKEN}\n`, { mode: 0o600 });
			harness = await createHarness({
				features: [bus, capture.feature],
				setupAgentDir: (agentDir) =>
					writeFileSync(join(agentDir, "pimon.json"), JSON.stringify({ features: { bus: { hub: { url } } } })),
			});
			await until(() => capture.get().online);
			expect(capture.get().unavailable()).toBeUndefined();
		} finally {
			await harness?.shutdown();
			harness?.dispose();
			harness = undefined;
			if (savedHome === undefined) delete process.env["HOME"];
			else process.env["HOME"] = savedHome;
			home.dispose();
		}
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { discovery } from "../../src/features/discovery/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const PROVIDER = "probe-proxy";
const ITEMS = [
	{ id: "alpha", context_length: 400_000, max_output_tokens: 32_000, capabilities: { vision: true } },
	{ id: "beta", capabilities: { effort_tiers: ["none", "low", "high"] } },
];

let server: Server;
let baseUrl = "";
let status = 200;
let body: string | undefined;
let hold: Promise<void> | undefined;
const seen: { url: string | undefined; auth: string | undefined }[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		seen.push({ url: request.url, auth: request.headers.authorization });
		void (hold ?? Promise.resolve()).then(() => {
			response.statusCode = status;
			response.setHeader("content-type", "application/json");
			response.end(body ?? (status === 200 ? JSON.stringify({ data: ITEMS }) : '{"error":"down"}'));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const writeModelsJson = (agentDir: string) =>
	writeFileSync(
		join(agentDir, "models.json"),
		`{
	// comments are allowed, like in pi
	"providers": {
		"${PROVIDER}": {
			"baseUrl": "${baseUrl}",
			"api": "openai-completions",
			"apiKey": "test-key",
			"dynamicDiscovery": { "timeoutMs": 2000 }
		}
	}
}`,
	);

const listed = (harness: Harness) =>
	harness.modelRuntime
		.getModels(PROVIDER)
		.map((model) => model.id)
		.sort();

const available = (harness: Harness) =>
	harness.modelRuntime
		.getAvailableSnapshot()
		.filter((model) => model.provider === PROVIDER)
		.map((model) => model.id)
		.sort();

const chatModel = (id: string) => ({
	id,
	name: id,
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

describe("discovery with the pi models store", () => {
	const harnesses: Harness[] = [];
	let home = "";
	let savedHome: string | undefined;

	beforeEach(() => {
		seen.length = 0;
		status = 200;
		body = undefined;
		savedHome = process.env["HOME"];
		home = mkdtempSync(join(tmpdir(), "pimon-discovery-home-"));
		process.env["HOME"] = home;
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose();
		if (savedHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = savedHome;
		rmSync(home, { recursive: true, force: true });
	});

	const start = async (modelsStore: InMemoryModelsStore, storeFile?: string) => {
		const setupAgentDir = (agentDir: string) => {
			writeModelsJson(agentDir);
			if (storeFile !== undefined) writeFileSync(join(agentDir, "models-store.json"), storeFile);
		};
		const harness = await createHarness({ features: [discovery], setupAgentDir, modelsStore });
		harnesses.push(harness);
		await harness.modelRuntime.refresh({ allowNetwork: false });
		return harness;
	};

	it("lists nothing and makes no request offline with an empty store", async () => {
		const harness = await start(new InMemoryModelsStore());
		expect(listed(harness)).toEqual([]);
		expect(seen).toEqual([]);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("persists fetched models so a new runtime lists them offline", async () => {
		const store = new InMemoryModelsStore();
		const first = await start(store);
		const result = await first.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });
		expect(result.errors.size).toBe(0);
		expect(seen).toEqual([{ url: "/v1/models", auth: "Bearer test-key" }]);
		expect(listed(first)).toEqual(["alpha", "beta"]);
		expect(first.modelRuntime.getModel(PROVIDER, "alpha")).toMatchObject({
			contextWindow: 400_000,
			maxTokens: 32_000,
			input: ["text", "image"],
		});

		const stored = await store.read(PROVIDER);
		expect(stored?.models.map((model) => model.id)).toEqual(["alpha", "beta"]);
		expect(stored?.checkedAt).toBeTypeOf("number");

		const second = await start(store);
		expect(listed(second)).toEqual(["alpha", "beta"]);
		expect(seen).toHaveLength(1);
	});

	it("keeps the stored list when the endpoint fails", async () => {
		const store = new InMemoryModelsStore();
		const harness = await start(store);
		await harness.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });
		const before = await store.read(PROVIDER);

		status = 500;
		await harness.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });
		expect(seen).toHaveLength(2);
		expect(listed(harness)).toEqual(["alpha", "beta"]);
		expect(await store.read(PROVIDER)).toEqual(before);
	});

	it.each([
		["an empty object", "{}"],
		["a null data field", '{"data": null}'],
		["an error object", '{"error": "busy"}'],
	])("keeps the stored list when a 200 response has %s", async (_name, payload) => {
		const store = new InMemoryModelsStore();
		const harness = await start(store);
		await harness.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });
		const before = await store.read(PROVIDER);

		body = payload;
		const result = await harness.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });
		expect(seen).toHaveLength(2);
		expect(result.errors.size).toBe(0);
		expect(listed(harness)).toEqual(["alpha", "beta"]);
		expect(await store.read(PROVIDER)).toEqual(before);
	});

	it("keeps stored models listed and available while a full network refresh waits", async () => {
		const store = new InMemoryModelsStore();
		const first = await start(store);
		await first.modelRuntime.refresh({ allowNetwork: true, providers: [PROVIDER] });

		const harness = await start(store, JSON.stringify({ [PROVIDER]: await store.read(PROVIDER) }));
		const alpha = harness.modelRuntime.getModel(PROVIDER, "alpha");
		if (!alpha) throw new Error("stored model missing");
		await harness.session.setModel(alpha);

		let release = () => {};
		hold = new Promise((resolve) => (release = resolve));
		const requests = seen.length;
		const refresh = harness.modelRuntime.refresh({ allowNetwork: true });
		try {
			for (let i = 0; i < 100 && seen.length === requests; i++) await new Promise((r) => setTimeout(r, 10));
			expect(seen.length).toBe(requests + 1);
			expect({ listed: listed(harness), available: available(harness) }).toEqual({
				listed: ["alpha", "beta"],
				available: ["alpha", "beta"],
			});
			expect(harness.session.model).toMatchObject({ provider: PROVIDER, id: "alpha" });
		} finally {
			release();
			hold = undefined;
			await refresh;
		}
		expect(listed(harness)).toEqual(["alpha", "beta"]);
	});

	const writeOldCache = (id: string) => {
		const cacheDir = join(home, ".cache", "pi", "dynamic-models");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, `${PROVIDER}.json`), JSON.stringify([chatModel(id)]));
	};

	it("falls back to the old cache file when the store is empty", async () => {
		writeOldCache("cached");
		const harness = await start(new InMemoryModelsStore());
		expect(listed(harness)).toEqual(["cached"]);
		expect(seen).toEqual([]);
	});

	it.each([
		["torn", '{"probe-proxy": {"models": [{"id": "al'],
		["not an object", "[]"],
		["missing provider", JSON.stringify({ other: { models: [chatModel("x")] } })],
		["models not an array", JSON.stringify({ [PROVIDER]: { models: "alpha" } })],
		["model without a string id", JSON.stringify({ [PROVIDER]: { models: [{ name: "x" }] } })],
	])("uses the old cache when the store file is %s", async (_name, storeFile) => {
		writeOldCache("cached");
		const harness = await start(new InMemoryModelsStore(), storeFile);
		expect(listed(harness)).toEqual(["cached"]);
		expect(available(harness)).toEqual(["cached"]);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("registers without saved models when the provider has no baseUrl", async () => {
		writeOldCache("cached");
		const harness = await createHarness({
			features: [discovery],
			modelsStore: new InMemoryModelsStore(),
			setupAgentDir: (agentDir) => {
				writeFileSync(
					join(agentDir, "models.json"),
					JSON.stringify({
						providers: {
							[PROVIDER]: {
								api: "openai-completions",
								apiKey: "k",
								headers: { "x-probe": "1" },
								dynamicDiscovery: { endpoint: `${baseUrl}/models` },
							},
						},
					}),
				);
				writeFileSync(
					join(agentDir, "models-store.json"),
					JSON.stringify({ [PROVIDER]: { models: [chatModel("x")] } }),
				);
			},
		});
		harnesses.push(harness);
		expect(harness.modelRuntime.getProvider(PROVIDER)).toBeDefined();
		expect(listed(harness)).toEqual([]);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("replaces the stored baseline with a network result", async () => {
		const harness = await start(
			new InMemoryModelsStore(),
			JSON.stringify({ [PROVIDER]: { models: [chatModel("retired")], checkedAt: 1 } }),
		);
		expect(listed(harness)).toEqual(["retired"]);
		await harness.modelRuntime.refresh({ allowNetwork: true });
		expect(listed(harness)).toEqual(["alpha", "beta"]);
		expect(available(harness)).toEqual(["alpha", "beta"]);
	});
});

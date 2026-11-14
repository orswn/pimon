import { describe, expect, it } from "vite-plus/test";
import { ConfigError, loadConfig } from "./config.ts";

describe("config", () => {
	it("uses the defaults", () => {
		expect(loadConfig([], {})).toEqual({
			host: "0.0.0.0",
			port: 8080,
			data: "/data",
			tokensFile: undefined,
			externalFile: undefined,
			testAgents: false,
			publicUrl: undefined,
			presenceGraceMs: 20_000,
			heartbeatMs: 15_000,
			pushAllow: [],
		});
	});

	it("reads the push allow list from env or flag, and adds loopback in test mode", () => {
		expect(loadConfig([], { HUB_PUSH_ALLOW: "hooks.example,10.0.0.0/8" }).pushAllow).toEqual([
			"hooks.example",
			"10.0.0.0/8",
		]);
		expect(loadConfig(["--push-allow", "192.168.1.0/24"], { HUB_PUSH_ALLOW: "x.example" }).pushAllow).toEqual([
			"192.168.1.0/24",
		]);
		expect(loadConfig(["--test-agents", "--push-allow", "x.example"], {}).pushAllow).toEqual([
			"x.example",
			"127.0.0.0/8",
			"::1",
		]);
		expect(() => loadConfig(["--push-allow", "10.0.0.0/40"], {})).toThrow(ConfigError);
	});

	it("reads env and lets flags win", () => {
		const env = {
			HUB_LISTEN: "127.0.0.1:9000",
			HUB_DATA: "/env",
			HUB_TOKENS_FILE: "/t.json",
			HUB_TEST_AGENTS: "1",
			HUB_PUBLIC_URL: "https://hub.example/",
			HUB_EXTERNAL_FILE: "/e.json",
		};
		expect(loadConfig(["--external", "/flag-e.json"], env).externalFile).toBe("/flag-e.json");
		expect(loadConfig([], env)).toMatchObject({
			externalFile: "/e.json",
			host: "127.0.0.1",
			port: 9000,
			data: "/env",
			tokensFile: "/t.json",
			testAgents: true,
			publicUrl: "https://hub.example",
		});
		expect(loadConfig(["--listen", "[::1]:0", "--data", "/flag"], env)).toMatchObject({
			host: "::1",
			port: 0,
			data: "/flag",
		});
	});

	it("refuses a bad listen address or public url", () => {
		expect(() => loadConfig(["--listen", "8080"], {})).toThrow(ConfigError);
		expect(() => loadConfig(["--listen", "h:99999"], {})).toThrow(ConfigError);
		expect(() => loadConfig(["--public-url", "hub.example"], {})).toThrow(ConfigError);
	});
});

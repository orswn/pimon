import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { statusline } from "../features/statusline/index.ts";
import { vi } from "../features/vi/index.ts";
import { loadConfigFile, planFeature } from "./config.ts";
import { defineFeature } from "./feature.ts";

const plain = defineFeature({ id: "plain", description: "", defaultEnabled: true, setup: () => undefined });
const optIn = defineFeature({ id: "opt-in", description: "", defaultEnabled: false, setup: () => undefined });
const tuned = defineFeature({
	id: "tuned",
	description: "",
	defaultEnabled: true,
	configSchema: Type.Object({ limit: Type.Number({ default: 5, minimum: 1 }) }, { additionalProperties: false }),
	setup: () => undefined,
});

describe("planFeature", () => {
	it("uses the feature default when the config has no entry", () => {
		expect(planFeature(plain, undefined)).toEqual({ id: "plain", state: "enabled", config: {} });
		expect(planFeature(optIn, undefined)).toMatchObject({ state: "disabled", reason: "off by default" });
	});

	it("accepts true, false, and an object with enabled", () => {
		expect(planFeature(optIn, true).state).toBe("enabled");
		expect(planFeature(plain, false)).toMatchObject({ state: "disabled", reason: "off in config" });
		expect(planFeature(plain, { enabled: false }).state).toBe("disabled");
	});

	it("fills schema defaults and validates options", () => {
		expect(planFeature(tuned, undefined)).toEqual({ id: "tuned", state: "enabled", config: { limit: 5 } });
		expect(planFeature(tuned, { limit: 9 })).toEqual({ id: "tuned", state: "enabled", config: { limit: 9 } });
		expect(planFeature(tuned, { limit: 0 })).toMatchObject({ state: "invalid" });
		expect(planFeature(tuned, { lmit: 3 })).toMatchObject({ state: "invalid" });
	});

	it("names an unknown option in the reason", () => {
		expect(planFeature(tuned, { lmit: 3 })).toEqual({ id: "tuned", state: "invalid", reason: "unknown option lmit" });
	});

	it("rejects unknown statusline and vi options", () => {
		expect(planFeature(statusline, { usagePolSeconds: 60 })).toEqual({
			id: "statusline",
			state: "invalid",
			reason: "unknown option usagePolSeconds",
		});
		expect(planFeature(vi, { clipbord: "never" })).toEqual({
			id: "vi",
			state: "invalid",
			reason: "unknown option clipbord",
		});
	});

	it("rejects options for a feature without a schema", () => {
		expect(planFeature(plain, { enabled: true, extra: 1 })).toMatchObject({ state: "invalid" });
	});
});

describe("loadConfigFile", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});
	const withFile = (text: string | undefined) => {
		dir = mkdtempSync(join(tmpdir(), "pimon-config-"));
		if (text !== undefined) writeFileSync(join(dir, "pimon.json"), text);
		return loadConfigFile(dir);
	};

	it("treats a missing file as empty", () => {
		expect(withFile(undefined)).toMatchObject({ file: {}, problems: [] });
	});

	it("reports invalid JSON, non-objects, and unknown keys", () => {
		expect(withFile("{").problems[0]).toContain("is not valid JSON");
		expect(withFile("[]").problems[0]).toContain("must contain a JSON object");
		expect(withFile('{"featurs":{}}').problems[0]).toContain('unknown key "featurs"');
	});
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TObject } from "typebox";
import { Value } from "typebox/value";
import type { Feature, FeatureId } from "./feature.ts";

export const CONFIG_FILE = "pimon.json";

export type FeatureSetting = boolean | { enabled?: boolean; [option: string]: unknown };

export interface PimonConfigFile {
	features?: Record<FeatureId, FeatureSetting>;
}

export type FeaturePlan =
	| { id: FeatureId; state: "enabled"; config: unknown }
	| { id: FeatureId; state: "disabled"; reason: string }
	| { id: FeatureId; state: "invalid"; reason: string };

export interface LoadedConfig {
	path: string;
	file: PimonConfigFile;
	problems: string[];
}

export function loadConfigFile(agentDir: string): LoadedConfig {
	const path = join(agentDir, CONFIG_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, file: {}, problems: [] };
		return { path, file: {}, problems: [`Cannot read ${path}: ${(error as Error).message}`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { path, file: {}, problems: [`${path} is not valid JSON: ${(error as Error).message}`] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { path, file: {}, problems: [`${path} must contain a JSON object`] };
	}
	const file = parsed as PimonConfigFile;
	const problems: string[] = [];
	for (const key of Object.keys(file)) {
		if (key !== "features") problems.push(`${path}: unknown key "${key}"`);
	}
	return { path, file, problems };
}

export function planFeature(feature: Feature, setting: FeatureSetting | undefined): FeaturePlan {
	const enabled = typeof setting === "boolean" ? setting : (setting?.enabled ?? feature.defaultEnabled);
	if (!enabled)
		return { id: feature.id, state: "disabled", reason: setting === undefined ? "off by default" : "off in config" };
	const options = typeof setting === "object" ? withoutEnabled(setting) : {};
	if (!feature.configSchema) {
		if (Object.keys(options).length > 0) {
			return { id: feature.id, state: "invalid", reason: `takes no options, got ${Object.keys(options).join(", ")}` };
		}
		return { id: feature.id, state: "enabled", config: {} };
	}
	return validateOptions(feature.id, feature.configSchema, options);
}

function withoutEnabled(setting: { enabled?: boolean; [option: string]: unknown }): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = setting;
	return rest;
}

function validateOptions(id: FeatureId, schema: TObject, options: Record<string, unknown>): FeaturePlan {
	const config = Value.Default(schema, structuredClone(options));
	if (!Value.Check(schema, config)) {
		const first = Value.Errors(schema, config)[0];
		const where = first?.instancePath || "/";
		return { id, state: "invalid", reason: `option ${where}: ${first?.message ?? "invalid"}` };
	}
	return { id, state: "enabled", config };
}

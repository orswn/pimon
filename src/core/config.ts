import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TObject } from "typebox";
import { Value } from "typebox/value";
import type { Feature, FeatureId } from "./feature.ts";

const CONFIG_FILE = "pimon.json";

type FeatureSetting = boolean | { enabled?: boolean; [option: string]: unknown };

interface PimonConfigFile {
	features?: Record<FeatureId, FeatureSetting>;
	/** `false` keeps a pimon tool unregistered. A missing entry and `true` keep it on. */
	tools?: Record<string, boolean>;
}

export type FeaturePlan =
	| { id: FeatureId; state: "enabled"; config: unknown }
	| { id: FeatureId; state: "disabled"; reason: string }
	| { id: FeatureId; state: "invalid"; reason: string };

interface LoadedConfig {
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
		if (key !== "features" && key !== "tools") problems.push(`${path}: unknown key "${key}"`);
	}
	if (file.tools !== undefined) file.tools = readTools(path, file.tools, problems);
	return { path, file, problems };
}

/** Tools whose text or flow tells the model to call another tool. */
const TOOL_NEEDS: Readonly<Record<string, readonly string[]>> = {
	pi_agents: ["pi_bus"],
	goal_done: ["timer", "notify"],
	goal_set: ["goal_done"],
	background_codemode: ["background"],
	monitor_codemode: ["monitor"],
};
const FEATURE_NEEDS: Readonly<Record<FeatureId, readonly string[]>> = { goal: ["goal_done"] };

export function toolNeedWarnings(
	switches: Readonly<Record<string, boolean>>,
	registered: ReadonlySet<string>,
	enabledFeatures: ReadonlySet<FeatureId>,
): string[] {
	const warnings: string[] = [];
	const check = (user: string, needs: readonly string[]) => {
		for (const need of needs) if (switches[need] === false) warnings.push(`tools.${need} is off, but ${user} needs it`);
	};
	for (const [tool, needs] of Object.entries(TOOL_NEEDS)) if (registered.has(tool)) check(tool, needs);
	for (const [feature, needs] of Object.entries(FEATURE_NEEDS)) if (enabledFeatures.has(feature)) check(feature, needs);
	return warnings;
}

function readTools(path: string, raw: unknown, problems: string[]): Record<string, boolean> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		problems.push(`${path}: tools must be an object of true or false values`);
		return undefined;
	}
	const tools: Record<string, boolean> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === "boolean") tools[name] = value;
		else problems.push(`${path}: tools.${name} must be true or false`);
	}
	return tools;
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
		if (first?.schemaPath === "#/additionalProperties")
			return { id, state: "invalid", reason: `unknown option ${where.slice(1)}` };
		return { id, state: "invalid", reason: `option ${where}: ${first?.message ?? "invalid"}` };
	}
	return { id, state: "enabled", config };
}

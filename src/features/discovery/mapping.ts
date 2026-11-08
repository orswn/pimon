import type { Api, Model, ModelCost, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
type Compat = Model<Api>["compat"];

export interface DiscoveryOptions {
	path?: string;
	endpoint?: string;
	timeoutMs?: number;
}

export interface ProviderJsonConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	dynamicDiscovery?: boolean | DiscoveryOptions;
}

export interface RawModelItem {
	id: string;
	name?: string;
	api?: string;
	context_length?: number;
	context_window?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	max_output_tokens?: number;
	reasoning?: boolean;
	input?: string[];
	capabilities?: {
		vision?: boolean;
		reasoning?: boolean;
		contextWindow?: number;
		maxOutput?: number;
		thinkingFormat?: string;
		modalities?: unknown;
		effort_tiers?: unknown;
	};
	effort_tiers?: unknown;
	thinkingLevelMap?: ThinkingLevelMap;
	pricing?: unknown;
	cost?: unknown;
	compat?: Record<string, unknown>;
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function num(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapCost(raw: unknown): ModelCost {
	if (!isRecord(raw)) return { ...ZERO_COST };
	const cost: ModelCost = {
		input: num(raw, "input") ?? 0,
		output: num(raw, "output") ?? 0,
		cacheRead: num(raw, "cached", "cacheRead") ?? 0,
		cacheWrite: num(raw, "cache_creation", "cacheWrite") ?? 0,
	};
	const rawTiers = Array.isArray(raw["tiers"]) ? raw["tiers"] : raw["long_context"] ? [raw["long_context"]] : undefined;
	if (rawTiers && rawTiers.length > 0) {
		cost.tiers = rawTiers.filter(isRecord).map((tier) => ({
			inputTokensAbove: num(tier, "inputTokensAbove", "threshold") ?? 272_000,
			input: num(tier, "input") ?? cost.input,
			output: num(tier, "output") ?? cost.output,
			cacheRead: num(tier, "cached", "cacheRead") ?? cost.cacheRead,
			cacheWrite: num(tier, "cache_creation", "cacheWrite") ?? cost.cacheWrite,
		}));
	}
	return cost;
}

export function thinkingLevelMapFromTiers(rawTiers: unknown): ThinkingLevelMap | undefined {
	if (!Array.isArray(rawTiers) || rawTiers.length === 0) return undefined;
	const tiers = new Set(rawTiers);
	const level = (name: string) => (tiers.has(name) ? name : null);
	return {
		off: tiers.has("none") || tiers.has("off") ? "off" : null,
		minimal: level("minimal"),
		low: level("low"),
		medium: level("medium"),
		high: level("high"),
		xhigh: level("xhigh"),
		max: level("max"),
	};
}

export function mapRawItemToModel(
	item: RawModelItem,
	providerConfig: ProviderJsonConfig,
	builtinMap: ReadonlyMap<string, Model<Api>>,
): ChatModelConfig {
	const id = item.id;
	const builtin = builtinMap.get(id);

	if (builtin) {
		return {
			id,
			name: item.name ?? builtin.name ?? id,
			api: item.api ?? builtin.api ?? providerConfig.api ?? "openai-completions",
			reasoning: item.capabilities?.reasoning ?? item.reasoning ?? builtin.reasoning ?? false,
			input: item.capabilities?.vision ? ["text", "image"] : (builtin.input ?? ["text"]),
			cost: isRecord(item.cost) ? mapCost(item.cost) : (builtin.cost ?? { ...ZERO_COST }),
			contextWindow:
				item.capabilities?.contextWindow ??
				item.context_length ??
				item.context_window ??
				builtin.contextWindow ??
				128_000,
			maxTokens:
				item.capabilities?.maxOutput ?? item.max_completion_tokens ?? item.max_tokens ?? builtin.maxTokens ?? 16_384,
			...(builtin.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
			compat: { ...builtin.compat, ...item.compat } as Compat,
		};
	}

	const modalities = item.capabilities?.modalities;
	const hasVision = Boolean(
		item.capabilities?.vision ||
		item.input?.includes("image") ||
		(Array.isArray(modalities) && modalities.includes("image")),
	);
	const compat: Record<string, unknown> = { ...providerConfig.compat, ...item.compat };
	if (item.capabilities?.thinkingFormat) compat["thinkingFormat"] = item.capabilities.thinkingFormat;
	const thinkingLevelMap =
		item.thinkingLevelMap ?? thinkingLevelMapFromTiers(item.capabilities?.effort_tiers ?? item.effort_tiers);

	return {
		id,
		name: item.name ?? id,
		api: providerConfig.api ?? "openai-completions",
		reasoning: Boolean(item.capabilities?.reasoning ?? item.reasoning ?? false),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: hasVision ? ["text", "image"] : ["text"],
		cost: mapCost(item.pricing ?? item.cost),
		contextWindow: item.capabilities?.contextWindow ?? item.context_length ?? item.context_window ?? 128_000,
		maxTokens:
			item.capabilities?.maxOutput ?? item.max_output_tokens ?? item.max_completion_tokens ?? item.max_tokens ?? 16_384,
		...(Object.keys(compat).length > 0 ? { compat: compat as Compat } : {}),
	};
}

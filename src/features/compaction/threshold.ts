export interface CompactionSettingsInput {
	enabled?: boolean;
	reserveTokens?: number;
	modelOverrides?: Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;
}

export interface ModelWindow {
	provider: string;
	id: string;
	contextWindow: number;
}

export interface Defaults {
	enabled: boolean;
	reserveTokens: number;
}

interface ThresholdInfo {
	key: string;
	enabled: boolean;
	threshold: number;
	hasOverride: boolean;
}

const modelKey = (model: Pick<ModelWindow, "provider" | "id">) => `${model.provider}/${model.id}`;

/** Same rule as pi: compact when context passes `contextWindow - reserveTokens`, with the per-model reserve first. */
export function compactionThreshold(
	model: ModelWindow,
	settings: CompactionSettingsInput | undefined,
	defaults: Defaults,
): ThresholdInfo {
	const key = modelKey(model);
	const override = settings?.modelOverrides?.[key];
	const reserve = override?.reserveTokens ?? settings?.reserveTokens ?? defaults.reserveTokens;
	return {
		key,
		enabled: settings?.enabled ?? defaults.enabled,
		threshold: model.contextWindow - reserve,
		hasOverride: override?.reserveTokens !== undefined,
	};
}

export function warningText(model: ModelWindow, threshold: number, maxThresholdTokens: number): string {
	const key = modelKey(model);
	const reserve = model.contextWindow - maxThresholdTokens;
	return `compaction: ${key} compacts at ${threshold} tokens. Add "compaction.modelOverrides": { "${key}": { "reserveTokens": ${reserve} } } to settings.json to compact at ${maxThresholdTokens}.`;
}

/** Available models plus the current one, which may lack credentials but still runs this session. */
export function overrideCandidates<M extends ModelWindow>(available: readonly M[], current: M | undefined): M[] {
	if (!current || available.some((model) => modelKey(model) === modelKey(current))) return [...available];
	return [...available, current];
}

/** Overrides for models that compact above the limit and have no override yet. */
export function missingOverrides(
	models: readonly ModelWindow[],
	settings: CompactionSettingsInput | undefined,
	defaults: Defaults,
	maxThresholdTokens: number,
): Record<string, { reserveTokens: number }> {
	const result: Record<string, { reserveTokens: number }> = {};
	for (const model of models) {
		const info = compactionThreshold(model, settings, defaults);
		if (info.hasOverride || info.threshold <= maxThresholdTokens) continue;
		result[info.key] = { reserveTokens: model.contextWindow - maxThresholdTokens };
	}
	return result;
}

import { join } from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineFeature } from "../../core/feature.ts";
import {
	type CompactionSettingsInput,
	compactionThreshold,
	missingOverrides,
	type ModelWindow,
	overrideCandidates,
	warningText,
} from "./threshold.ts";

const configSchema = Type.Object(
	{
		maxThresholdTokens: Type.Integer({ minimum: 1, default: 256_000 }),
	},
	{ additionalProperties: false },
);

export const compaction = defineFeature({
	id: "compaction",
	description: "Warn about models that compact later than the token limit and print settings overrides for them",
	defaultEnabled: true,
	configSchema,
	setup(ctx) {
		const { maxThresholdTokens } = ctx.config;
		const warned = ctx.reloadState("warned", 1, () => new Set<string>());
		const settings = () => ctx.pi.getSettings().compaction as CompactionSettingsInput | undefined;

		const check = (model: ModelWindow | undefined, extensionCtx: ExtensionContext) => {
			if (!model) return;
			const info = compactionThreshold(model, settings(), DEFAULT_COMPACTION_SETTINGS);
			if (!info.enabled || info.threshold <= maxThresholdTokens || warned.has(info.key)) return;
			warned.add(info.key);
			extensionCtx.ui.notify(warningText(model, info.threshold, maxThresholdTokens), "warning");
		};

		ctx.onSessionStart((_event, extensionCtx) => check(extensionCtx.model, extensionCtx));
		ctx.pi.on("model_select", (event, extensionCtx) => check(event.model, extensionCtx));

		ctx.pi.registerCommand("compaction-overrides", {
			description: "Print compaction.modelOverrides entries for available models that compact above the token limit",
			handler: async (_args, extensionCtx) => {
				const available = await extensionCtx.modelRegistry.getAvailableOfType("chat");
				const overrides = missingOverrides(
					overrideCandidates(available, extensionCtx.model),
					settings(),
					DEFAULT_COMPACTION_SETTINGS,
					maxThresholdTokens,
				);
				const keys = Object.keys(overrides).sort();
				if (keys.length === 0) {
					extensionCtx.ui.notify("No available model needs a compaction.modelOverrides entry.", "info");
					return;
				}
				const sorted = Object.fromEntries(keys.map((key) => [key, overrides[key]]));
				const target = join(ctx.agentDir, "settings.json");
				extensionCtx.ui.notify(
					`Add under "compaction.modelOverrides" in ${target}:\n${JSON.stringify(sorted, null, 2)}`,
					"info",
				);
			},
		});
	},
});

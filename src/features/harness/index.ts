import { defineFeature } from "../../core/feature.ts";
import { HARNESS_PROMPT } from "./prompt.ts";

export const harness = defineFeature({
	id: "harness",
	description: "Core operating rules for the model: authority, proportionality, tool use, async work, recovery",
	defaultEnabled: true,
	setup(ctx) {
		ctx.promptSection({ name: "harness", render: () => HARNESS_PROMPT });
	},
});

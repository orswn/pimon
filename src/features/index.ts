import type { AnyFeature } from "../core/feature.ts";
import { ancestorConfig } from "./ancestor-config/index.ts";
import { askSecret } from "./ask-secret/index.ts";
import { background } from "./background/index.ts";
import { compaction } from "./compaction/index.ts";
import { discovery } from "./discovery/index.ts";
import { harness } from "./harness/index.ts";
import { imageBudget } from "./image-budget/index.ts";

export const features: readonly AnyFeature[] = [
	harness,
	imageBudget,
	background,
	askSecret,
	compaction,
	ancestorConfig,
	discovery,
];

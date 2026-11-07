import type { AnyFeature } from "../core/feature.ts";
import { harness } from "./harness/index.ts";
import { imageBudget } from "./image-budget/index.ts";

export const features: readonly AnyFeature[] = [harness, imageBudget];

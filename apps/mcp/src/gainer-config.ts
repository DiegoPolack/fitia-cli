import { adaptiveBounds } from "@fitia/core/gainer/adaptive";
import {
  defaultGainerConfig,
  type GainerConfig,
  gainerModes,
  gainerRecipe,
  sweetenerModes,
} from "@fitia/core/gainer/recipe";
import { CliError } from "@fitia/core/runtime";
import * as z from "zod/v4";

const macroProfile = z.strictObject({
  caloriesKcal: z.number().min(0).max(900),
  proteinG: z.number().min(0).max(100),
  carbsG: z.number().min(0).max(100),
  fatG: z.number().min(0).max(100),
});
export const ingredientIds = gainerRecipe.ingredients.map((i) => i.id);
const factors = z.strictObject({ minFactor: z.number().min(0).max(10), maxFactor: z.number().min(0).max(10) });
const weights = z.strictObject({
  caloriesKcal: z.number().positive().max(20).optional(),
  proteinG: z.number().positive().max(20).optional(),
  carbsG: z.number().positive().max(20).optional(),
  fatG: z.number().positive().max(20).optional(),
});
const adaptivePatch = z.strictObject({
  bounds: z.partialRecord(z.enum(ingredientIds), factors).optional(),
  deviationWeight: z.number().min(0).max(1).optional(),
  metricWeights: weights.optional(),
  alreadyHighMultipliers: weights.optional(),
  waterMlPerDryGram: z.number().min(1).max(10).optional(),
  maxDrySolidsG: z.number().min(10).max(1000).optional(),
  maxBatchCaloriesKcal: z.number().min(1).max(10000).optional(),
});
export const gainerConfigPatch = z.strictObject({
  sweetenerInventory: z.enum(["unknown", ...sweetenerModes]).optional(),
  defaultMode: z.enum(gainerModes).optional(),
  adaptive: adaptivePatch.optional(),
  honeyGramsPerTablespoon: z.number().min(1).max(100).optional(),
  preferredNightCaloriesKcal: z.number().min(1).max(20000).optional(),
  maxNightCaloriesKcal: z.number().min(1).max(20000).optional(),
  honeyProfile: z
    .strictObject({
      source: z.enum(["standard_reference", "product_label"]),
      label: z.string().trim().min(1).max(200),
      per100G: macroProfile,
    })
    .optional(),
});
export type GainerConfigPatch = z.infer<typeof gainerConfigPatch>;
export function mergeGainerConfig(base: GainerConfig, patch: GainerConfigPatch): GainerConfig {
  return {
    ...base,
    ...patch,
    adaptive: {
      ...base.adaptive,
      ...patch.adaptive,
      bounds: { ...base.adaptive.bounds, ...patch.adaptive?.bounds },
      metricWeights: { ...base.adaptive.metricWeights, ...patch.adaptive?.metricWeights },
      alreadyHighMultipliers: { ...base.adaptive.alreadyHighMultipliers, ...patch.adaptive?.alreadyHighMultipliers },
    },
  };
}
export function parseGainerConfig(value: unknown): GainerConfig {
  // Validate stored overrides as strictly as tool input. Never hide corruption behind defaults.
  const config = mergeGainerConfig(defaultGainerConfig(), gainerConfigPatch.parse(value));
  const bounds = adaptiveBounds(config.adaptive);
  if (Object.values(config.adaptive.bounds).some((b) => b.minFactor > b.maxFactor) || bounds.some((b) => b.min > b.max))
    throw new CliError(
      "INVALID_ADAPTIVE_BOUNDS",
      "Each bound must contain at least one whole unit and minFactor must not exceed maxFactor.",
      "Review adaptive bounds.",
    );
  const minimumDry =
    gainerRecipe.creatineG +
    bounds.reduce((sum, b, n) => sum + (gainerRecipe.ingredients[n]!.unit === "g" ? b.min : 0), 0);
  if (minimumDry > config.adaptive.maxDrySolidsG)
    throw new CliError(
      "INVALID_ADAPTIVE_LIMITS",
      "Minimum ingredient amounts exceed the dry solids limit.",
      "Review adaptive bounds and global limits together.",
    );
  if (config.preferredNightCaloriesKcal > config.maxNightCaloriesKcal)
    throw new CliError(
      "INVALID_NIGHT_LIMITS",
      "Preferred night calories cannot exceed the night maximum.",
      "Update both limits together if necessary.",
    );
  return config;
}
export interface GainerConfigSnapshot {
  config: GainerConfig;
  version: string;
  persisted: boolean;
}
export interface GainerConfigStore {
  get(): Promise<GainerConfigSnapshot>;
  update(patch: GainerConfigPatch, confirm: boolean, expectedVersion?: string): Promise<unknown>;
}
export const unconfiguredGainerStore: GainerConfigStore = {
  async get() {
    return { config: defaultGainerConfig(), version: "0", persisted: false };
  },
  async update() {
    throw new CliError(
      "REMOTE_CONFIG_REQUIRED",
      "Persistent gainer configuration requires the authenticated remote MCP.",
      "Connect to the existing Fitia remote MCP; local calculations can use an explicit sweetener.",
    );
  },
};

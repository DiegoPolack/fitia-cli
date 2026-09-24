import { adaptiveBounds, minimumAdaptiveAmounts } from "@fitia/core/gainer/adaptive";
import { drySolidsG } from "@fitia/core/gainer/portion";
import {
  assertLegacyProfile,
  futureRecipeProfile,
  legacyRecipeProfile,
  profileIds,
  type RecipeProfile,
  resolveRecipe,
} from "@fitia/core/gainer/profiles";
import {
  adaptiveMainIds,
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
  strategy: z.enum(["legacy_v1", "proportional_v2"]).optional(),
  ingredientDeviation: z.partialRecord(z.enum(adaptiveMainIds), z.number().min(0).max(1)).optional(),
  waterMlPerMainDryGram: z.number().positive().max(20).optional(),
  bounds: z.partialRecord(z.enum(ingredientIds), factors).optional(),
  deviationWeight: z.number().min(0).max(1).optional(),
  metricWeights: weights.optional(),
  alreadyHighMultipliers: weights.optional(),
  waterMlPerDryGram: z.number().min(1).max(10).optional(),
  maxDrySolidsG: z.number().min(10).max(1000).optional(),
  maxBatchCaloriesKcal: z.number().min(1).max(10000).optional(),
});
export const profileIngredientIds = [...ingredientIds, "maltodex"] as const;
const profileNutrition = z.strictObject({
  basisAmount: z.number().positive().max(10000),
  source: z.enum(["historical_recipe", "product_label"]),
  macros: z.strictObject({
    caloriesKcal: z.number().min(0).max(10000).nullable(),
    proteinG: z.number().min(0).max(1000).nullable(),
    carbsG: z.number().min(0).max(1000).nullable(),
    fatG: z.number().min(0).max(1000).nullable(),
  }),
  fiberG: z.number().min(0).max(1000).nullable().optional(),
});
const profileIngredient = z.strictObject({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(200),
  baseAmount: z.number().positive().max(1000).nullable(),
  unit: z.enum(["g", "ml"]),
  amountMode: z.enum(["base", "water_ratio"]),
  gramsPer100MlWater: z.number().positive().max(100).nullable(),
  concentrationBounds: z
    .strictObject({ min: z.number().min(0).max(100), max: z.number().positive().max(100) })
    .nullable(),
  nutrition: profileNutrition.nullable(),
  price: z
    .strictObject({ pen: z.number().min(0).max(100000), packageAmount: z.number().positive().max(100000) })
    .nullable(),
  adaptiveBounds: factors.nullable(),
  flavor: z.literal("unflavored").optional(),
  declaredIngredients: z.array(z.string().min(1).max(100)).max(30).optional(),
});
const profileSchema = z.strictObject({
  ingredients: z.partialRecord(z.enum(profileIngredientIds), profileIngredient),
  waterMode: z.enum(["legacy", "structural_solids"]),
  adaptive: adaptivePatch.omit({ bounds: true }),
  costOptimizationEnabled: z.literal(false),
  practicalityOptimizationEnabled: z.literal(false),
});
const futureProfilePatch = profileSchema.partial().extend({
  ingredients: z.partialRecord(z.enum(profileIngredientIds), profileIngredient.partial()).optional(),
});
export const gainerConfigPatch = z.strictObject({
  activeProfile: z.enum(profileIds).optional(),
  recipeProfiles: z
    .strictObject({ legacy_v1: profileSchema.optional(), future_v2: futureProfilePatch.optional() })
    .optional(),
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
  const recipeProfiles = { ...base.recipeProfiles };
  if (patch.recipeProfiles?.legacy_v1) {
    const supplied = patch.recipeProfiles.legacy_v1;
    const old = base.recipeProfiles.legacy_v1.adaptive;
    const legacy = {
      ...supplied,
      adaptive: {
        ...old,
        ...supplied.adaptive,
        metricWeights: { ...old.metricWeights, ...supplied.adaptive.metricWeights },
        alreadyHighMultipliers: { ...old.alreadyHighMultipliers, ...supplied.adaptive.alreadyHighMultipliers },
      },
    };
    assertLegacyProfile(legacy);
    // JSONB does not retain object key order. Validate every supplied value, then
    // restore canonical ordering for the existing strict mutation readback check.
    recipeProfiles.legacy_v1 = legacyRecipeProfile();
  }
  if (patch.recipeProfiles?.future_v2) {
    const saved = recipeProfiles.future_v2 ?? futureRecipeProfile(),
      changes = patch.recipeProfiles.future_v2;
    const ingredients = { ...saved.ingredients };
    for (const id of profileIngredientIds)
      if (changes.ingredients?.[id]) {
        const previous = ingredients[id];
        if (!previous) throw new Error(`No product definition for ${id}`);
        ingredients[id] = { ...previous, ...changes.ingredients[id] };
      }
    recipeProfiles.future_v2 = {
      ...saved,
      ...changes,
      ingredients,
      adaptive: {
        ...saved.adaptive,
        ...changes.adaptive,
        metricWeights: { ...saved.adaptive.metricWeights, ...changes.adaptive?.metricWeights },
        alreadyHighMultipliers: {
          ...saved.adaptive.alreadyHighMultipliers,
          ...changes.adaptive?.alreadyHighMultipliers,
        },
      },
    };
  }
  return {
    ...base,
    ...patch,
    recipeProfiles,
    adaptive: {
      ...base.adaptive,
      ...patch.adaptive,
      ingredientDeviation: { ...base.adaptive.ingredientDeviation, ...patch.adaptive?.ingredientDeviation },
      bounds: { ...base.adaptive.bounds, ...patch.adaptive?.bounds },
      metricWeights: { ...base.adaptive.metricWeights, ...patch.adaptive?.metricWeights },
      alreadyHighMultipliers: { ...base.adaptive.alreadyHighMultipliers, ...patch.adaptive?.alreadyHighMultipliers },
    },
  };
}
export function parseGainerConfig(value: unknown): GainerConfig {
  // Validate stored overrides as strictly as tool input. Never hide corruption behind defaults.
  const config = mergeGainerConfig(defaultGainerConfig(), gainerConfigPatch.parse(value));
  for (const profile of Object.values(config.recipeProfiles) as RecipeProfile[])
    for (const [id, i] of Object.entries(profile.ingredients)) {
      if (!i) continue;
      if (i.adaptiveBounds && i.adaptiveBounds.minFactor > i.adaptiveBounds.maxFactor)
        throw new CliError(
          "INVALID_RECIPE_PROFILE",
          `${id}: inverted adaptive bounds.`,
          "Review the ingredient bounds.",
        );
      if (i.concentrationBounds && i.concentrationBounds.min > i.concentrationBounds.max)
        throw new CliError(
          "INVALID_RECIPE_PROFILE",
          `${id}: inverted concentration bounds.`,
          "Review the concentration bounds.",
        );
      if (
        i.enabled &&
        ((i.nutrition && Object.values(i.nutrition.macros).some((v) => v === null)) ||
          (!i.nutrition && !["cinnamon", "vanilla"].includes(id)))
      )
        throw new CliError(
          "INCOMPLETE_INGREDIENT_NUTRITION",
          `${id}: enabled ingredient needs all four known macros, including proteinG.`,
          "Keep it disabled until the actual nutrition is known.",
        );
    }
  const resolved = resolveRecipe(config);
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
  if (config.adaptive.strategy !== "proportional_v2" && minimumDry > config.adaptive.maxDrySolidsG)
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
  if (config.activeProfile !== "legacy_v1") {
    const profileBounds = adaptiveBounds(resolved.adaptive, resolved);
    if (profileBounds.some((b) => !(b.id === "anchor" && resolved.anchorWaterRatio) && b.min > b.max))
      throw new CliError(
        "INVALID_ADAPTIVE_BOUNDS",
        "Profile bounds must contain whole units.",
        "Review future_v2 bounds.",
      );
    const minDry = drySolidsG(minimumAdaptiveAmounts(resolved.adaptive, resolved), resolved);
    if (minDry > resolved.adaptive.maxDrySolidsG)
      throw new CliError(
        "INVALID_ADAPTIVE_LIMITS",
        "Profile minimum amounts exceed dry solids limit.",
        "Review future_v2 limits.",
      );
  }
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

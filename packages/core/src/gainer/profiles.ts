import { CliError } from "../errors.ts";
import { emptyMacros, type Macros, type MaybeMacros, macroKeys } from "../nutrition.ts";
import {
  type AdaptiveConfig,
  baseMixNutrition,
  defaultAdaptiveConfig,
  type GainerConfig,
  type GainerIngredient,
  gainerRecipe,
} from "./recipe.ts";

export const profileIds = ["legacy_v1", "future_v2"] as const;
export type ProfileId = (typeof profileIds)[number];
export type ProfileIngredientId = GainerIngredient["id"];
export type Factors = { minFactor: number; maxFactor: number };
export interface ProfileIngredient {
  enabled: boolean;
  name: string;
  baseAmount: number | null;
  unit: "g" | "ml";
  amountMode: "base" | "water_ratio";
  gramsPer100MlWater: number | null;
  concentrationBounds: { min: number; max: number } | null;
  nutrition: {
    basisAmount: number;
    macros: MaybeMacros;
    source: "historical_recipe" | "product_label";
    fiberG?: number | null;
  } | null;
  price: { pen: number; packageAmount: number } | null;
  adaptiveBounds: Factors | null;
  flavor?: "unflavored";
  declaredIngredients?: string[];
}
export interface RecipeProfile {
  ingredients: Partial<Record<ProfileIngredientId, ProfileIngredient>>;
  waterMode: "legacy" | "structural_solids";
  adaptive: Omit<AdaptiveConfig, "bounds">;
  costOptimizationEnabled: false;
  practicalityOptimizationEnabled: false;
}
export interface RecipeProfiles {
  legacy_v1: RecipeProfile;
  future_v2?: RecipeProfile;
}

// Supplied product label, not a generic maltodextrin model. Unknown protein stays null.
export function maltodexCandidate(): ProfileIngredient {
  return {
    name: "Universe Nutrition Maltodex",
    enabled: false,
    baseAmount: null,
    unit: "g",
    amountMode: "base",
    gramsPer100MlWater: null,
    concentrationBounds: null,
    adaptiveBounds: null,
    nutrition: {
      basisAmount: 40,
      macros: { caloriesKcal: 152, proteinG: null, carbsG: 38, fatG: 0 },
      fiberG: 0,
      source: "product_label",
    },
    price: { pen: 76.45, packageAmount: 5000 },
    flavor: "unflavored",
    declaredIngredients: ["dehydrated_orange", "maltodextrin", "dextrose", "citric_acid_SIN_330", "sucralose_SIN_955"],
  };
}

export function legacyRecipeProfile(): RecipeProfile {
  const { bounds, ...adaptive } = defaultAdaptiveConfig();
  return {
    ingredients: {
      ...Object.fromEntries(
        gainerRecipe.ingredients.map((i) => [
          i.id,
          {
            name: i.name,
            enabled: true,
            baseAmount: i.amount,
            unit: i.unit,
            amountMode: "base",
            gramsPer100MlWater: null,
            concentrationBounds: null,
            nutrition: i.nutrition
              ? { basisAmount: i.amount, macros: { ...i.nutrition }, source: "historical_recipe" }
              : null,
            price: { ...i.price },
            adaptiveBounds: { ...bounds[i.id] },
          },
        ]),
      ),
      maltodex: maltodexCandidate(),
    },
    waterMode: "legacy",
    adaptive,
    costOptimizationEnabled: false,
    practicalityOptimizationEnabled: false,
  };
}
export const defaultRecipeProfiles = (): RecipeProfiles => ({ legacy_v1: legacyRecipeProfile() });

// Explicit draft factory, never selected or persisted by a read/default normalization.
export function futureRecipeProfile(): RecipeProfile {
  const profile = legacyRecipeProfile();
  profile.waterMode = "structural_solids";
  profile.ingredients.anchor = {
    ...profile.ingredients.anchor!,
    amountMode: "water_ratio",
    baseAmount: null,
    adaptiveBounds: null,
  };
  // Must choose the future practical cap explicitly; do not inherit the historical 6× cap.
  profile.ingredients.nestum = { ...profile.ingredients.nestum!, adaptiveBounds: null };
  return profile;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, canonical(value)]),
        )
      : v;
function fail(message: string): never {
  throw new CliError(
    "INVALID_RECIPE_PROFILE",
    message,
    "Complete the inactive future_v2 profile before selecting it. legacy_v1 is immutable.",
  );
}
export function assertLegacyProfile(profile: RecipeProfile) {
  if (JSON.stringify(canonical(profile)) !== JSON.stringify(canonical(legacyRecipeProfile())))
    fail("legacy_v1 is frozen; edit future_v2 instead.");
}

export interface RuntimeRecipe {
  id: "polack_labs_mass_gainer_v1" | "polack_labs_mass_gainer_v2";
  name: string;
  profileId: ProfileId;
  ingredients: readonly GainerIngredient[];
  baseNutrition: Macros;
  waterMl: number;
  creatineG: number;
  waterMode: RecipeProfile["waterMode"];
  adaptive: AdaptiveConfig;
  anchorWaterRatio: { gramsPer100MlWater: number; min: number; max: number } | null;
}
export function legacyRuntimeRecipe(adaptive = defaultAdaptiveConfig()): RuntimeRecipe {
  return {
    ...gainerRecipe,
    profileId: "legacy_v1",
    baseNutrition: baseMixNutrition,
    waterMode: "legacy",
    adaptive,
    anchorWaterRatio: null,
  };
}

export function resolveRecipe(config: GainerConfig): RuntimeRecipe {
  assertLegacyProfile(config.recipeProfiles.legacy_v1);
  if (config.activeProfile === "legacy_v1") return legacyRuntimeRecipe(config.adaptive);
  const profile = config.recipeProfiles.future_v2;
  if (!profile) fail("activeProfile=future_v2 requires a configured profile.");
  if (profile.waterMode !== "structural_solids")
    fail("future_v2 must explicitly use structural_solids water calculation.");
  const active = Object.entries(profile.ingredients).filter(([, i]) => i?.enabled) as [
    ProfileIngredientId,
    ProfileIngredient,
  ][];
  let structuralBaseG = 0;
  for (const [id, i] of active) {
    if (i.amountMode === "water_ratio" && (id !== "anchor" || i.unit !== "g"))
      fail("Only Anchor in grams supports water_ratio.");
    if (i.amountMode === "base") {
      if (i.baseAmount === null || i.baseAmount <= 0) fail(`${id}: enabled ingredient requires a positive baseAmount.`);
      if (i.unit === "g") structuralBaseG += i.baseAmount;
    }
    if (i.nutrition === null) {
      if (id !== "cinnamon" && id !== "vanilla")
        fail(`${id}: enabled ingredient requires a complete nutrition profile.`);
    } else if (macroKeys.some((key) => i.nutrition!.macros[key] === null))
      fail(`${id}: enabled ingredient has unknown macros (including proteinG); no zero is inferred.`);
  }
  const waterMl = structuralBaseG * profile.adaptive.waterMlPerDryGram;
  let anchorWaterRatio: RuntimeRecipe["anchorWaterRatio"] = null;
  const bounds: AdaptiveConfig["bounds"] = { ...defaultAdaptiveConfig().bounds };
  const ingredients: GainerIngredient[] = active.map(([id, i]) => {
    let amount = i.baseAmount!;
    if (i.amountMode === "water_ratio") {
      const ratio = i.gramsPer100MlWater,
        limits = i.concentrationBounds;
      if (!ratio || !limits || limits.min < 0 || limits.min > ratio || limits.max < ratio || waterMl <= 0)
        fail(
          "Anchor water_ratio needs an explicit positive ratio, concentration min/max enclosing it, and structural solids.",
        );
      anchorWaterRatio = { gramsPer100MlWater: ratio, ...limits };
      amount = (waterMl * ratio) / 100;
      bounds.anchor = { minFactor: limits.min / ratio, maxFactor: limits.max / ratio };
    } else {
      if (!i.adaptiveBounds) fail(`${id}: enabled ingredient requires explicit adaptiveBounds.`);
      Object.assign(bounds, { [id]: i.adaptiveBounds });
    }
    const nutrition = i.nutrition
      ? (Object.fromEntries(
          macroKeys.map((key) => [key, (i.nutrition!.macros[key]! * amount) / i.nutrition!.basisAmount]),
        ) as Macros)
      : null;
    return { id, name: i.name, amount, unit: i.unit, nutrition, price: i.price };
  });
  const baseNutrition = ingredients.reduce<Macros>((sum, i) => {
    for (const key of macroKeys) sum[key] += i.nutrition?.[key] ?? 0;
    return sum;
  }, emptyMacros());
  if (baseNutrition.caloriesKcal <= 0)
    fail("Active profile needs at least one ingredient with known positive calories.");
  return {
    id: "polack_labs_mass_gainer_v2",
    name: "Polack Labs Mass Gainer v2",
    profileId: "future_v2",
    ingredients,
    baseNutrition,
    waterMl,
    creatineG: gainerRecipe.creatineG,
    waterMode: profile.waterMode,
    adaptive: { ...profile.adaptive, bounds },
    anchorWaterRatio,
  };
}

import { createHash } from "node:crypto";
import { validateDate } from "../diary.ts";
import { CliError } from "../errors.ts";
import { type DaySummary, type Macros, macroKeys, round } from "../nutrition.ts";
import { validAdaptiveAmounts } from "./adaptive.ts";
import { type ProportionalPreparation, validateProportionalPreparation } from "./adaptive-proportional.ts";
import { greenRanges } from "./optimization.ts";
import {
  amountsNutrition,
  fitsProfile,
  portionNutrition,
  quantity,
  roundedMacros,
  scaledAmounts,
  scaleMacros,
  waterForAmounts,
} from "./portion.ts";
import { type RuntimeRecipe, resolveRecipe } from "./profiles.ts";
import { type GainerConfig, gainerRecipe, type RecipeAmounts, type SweetenerInventory } from "./recipe.ts";

export const servingPolicy = { percentStep: 1, minimumCarryoverCaloriesKcal: 100 } as const;
export type ConcreteSweetener = Exclude<SweetenerInventory, "unknown">;
export type CarryoverDraft = {
  sourceDate: string;
  recipeId: RuntimeRecipe["id"];
  scaleFactor: number;
  sweetener: ConcreteSweetener;
  nightPercent: number;
  adaptiveAmounts?: RecipeAmounts;
  adaptivePreparation?: ProportionalPreparation;
};

export function nextDate(date: string) {
  validateDate(date);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const result = next.toISOString().slice(0, 10);
  validateDate(result);
  return result;
}

export function divideNutrition(batch: Macros, nightPercent: number) {
  const night = roundedMacros(scaleMacros(batch, nightPercent / 100));
  const morning = Object.fromEntries(macroKeys.map((key) => [key, round(batch[key] - night[key])])) as Macros;
  return { night, morning };
}

// Whole percentages refer to the weight of the finished, thoroughly blended batch,
// not ingredient-by-ingredient rounding or an invented final drink volume.
export function nightPercentage(batch: Macros, config: GainerConfig, day: DaySummary) {
  const feasible = Array.from({ length: 99 }, (_, i) => i + 1).filter(
    (percent) => divideNutrition(batch, percent).night.caloriesKcal <= config.maxNightCaloriesKcal,
  );
  if (!feasible.length)
    throw new CliError(
      "NIGHT_PORTION_TOO_SMALL",
      "No whole-percent serving fits the night limit.",
      "Review the batch size or configured limits.",
    );
  const substantialRemainder = feasible.filter(
    (p) => divideNutrition(batch, p).morning.caloriesKcal >= servingPolicy.minimumCarryoverCaloriesKcal,
  );
  let best = (substantialRemainder.length ? substantialRemainder : feasible).reduce((a, b) => {
    const distance = (p: number) => Math.abs((batch.caloriesKcal * p) / 100 - config.preferredNightCaloriesKcal);
    return distance(b) < distance(a) ? b : a;
  });
  const ranges = greenRanges(day.goals);
  const states = (percent: number) => {
    const portion = divideNutrition(batch, percent).night;
    return macroKeys.map((key) => {
      if (!ranges || day.consumed[key] === null) return "unknown";
      const value = day.consumed[key] + portion[key];
      return value < ranges[key].min ? "low" : value > ranges[key].max ? "high" : "green";
    });
  };
  // Exceed the preferred amount only to resolve another deficit without pushing
  // another metric high. The hard maximum always wins.
  for (const percent of feasible.filter((p) => p > best)) {
    const before = states(best),
      after = states(percent);
    const material =
      after.some((s, i) => s === "green" && before[i] === "low") &&
      !after.some((s, i) => s === "high" && before[i] !== "high");
    const tinyRemainder =
      divideNutrition(batch, best).morning.caloriesKcal < servingPolicy.minimumCarryoverCaloriesKcal;
    // Do not make an already tiny remainder smaller just to improve one metric.
    if (
      material &&
      !tinyRemainder &&
      divideNutrition(batch, percent).morning.caloriesKcal >= servingPolicy.minimumCarryoverCaloriesKcal
    )
      best = percent;
  }
  return best;
}

export function makeCarryoverPlan(draft: CarryoverDraft, config: GainerConfig) {
  const recipe = resolveRecipe(config),
    baseMixNutrition = recipe.baseNutrition;
  if (draft.recipeId !== recipe.id)
    throw new CliError(
      "RECIPE_PROFILE_MISMATCH",
      "Carryover recipe must match its frozen profile.",
      "Use the calculator draft and its matching config version.",
    );
  const targetDate = nextDate(draft.sourceDate);
  const configuredSweetener = gainerRecipe.sweeteners[draft.sweetener];
  const sweetener = draft.adaptivePreparation
    ? { ...configuredSweetener, honeyTablespoons: draft.adaptivePreparation.honeyTablespoons }
    : configuredSweetener;
  const honeyG = Math.round(sweetener.honeyTablespoons * config.honeyGramsPerTablespoon);
  const honey = scaleMacros(config.honeyProfile.per100G, honeyG / 100);
  const amounts = draft.adaptiveAmounts;
  if (draft.adaptivePreparation && !amounts)
    throw new CliError(
      "INVALID_ADAPTIVE_BATCH",
      "Versioned adaptive preparation requires concrete amounts.",
      "Use the complete calculator draft.",
    );
  const proportionalBatch =
    draft.adaptivePreparation && amounts
      ? validateProportionalPreparation(amounts, draft.adaptivePreparation, draft.sweetener, config, recipe)
      : null;
  const nutrition = amounts
    ? amountsNutrition(amounts, honey, recipe)
    : portionNutrition(draft.scaleFactor, honey, honey, recipe).practical;
  if (
    amounts &&
    ((!proportionalBatch && !validAdaptiveAmounts(amounts, recipe.adaptive, recipe)) ||
      nutrition.caloriesKcal > recipe.adaptive.maxBatchCaloriesKcal ||
      Math.abs(
        draft.scaleFactor -
          amountsNutrition(amounts, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, recipe).caloriesKcal /
            baseMixNutrition.caloriesKcal,
      ) > 1e-6)
  )
    throw new CliError(
      "INVALID_ADAPTIVE_BATCH",
      "Adaptive batch quantities or scale do not match the saved configuration.",
      "Use the exact draft returned by the calculator.",
    );
  const portions = divideNutrition(nutrition, draft.nightPercent);
  if (
    nutrition.caloriesKcal <= config.maxNightCaloriesKcal ||
    portions.night.caloriesKcal > config.maxNightCaloriesKcal ||
    portions.morning.caloriesKcal <= 0
  )
    throw new CliError(
      "INVALID_CARRYOVER_SPLIT",
      "The split does not satisfy the configured night limits.",
      "Use the carryoverDraft returned by a split calculation.",
    );
  const practicalAmounts = amounts ?? scaledAmounts(draft.scaleFactor, recipe);
  if (!fitsProfile(practicalAmounts, nutrition, recipe))
    throw new CliError(
      "INVALID_RECIPE_BATCH",
      "Carryover exceeds the frozen profile bounds or batch limits.",
      "Use the exact draft returned by the calculator.",
    );
  const fullBatch = {
    practicalNutrition: nutrition,
    ingredients: recipe.ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      ...(i.unit === "g"
        ? { practicalG: quantity(practicalAmounts, i.id) }
        : { practicalMl: quantity(practicalAmounts, i.id) }),
    })),
    water: {
      practicalMl:
        Math.round(
          (amounts || recipe.waterMode !== "legacy"
            ? (proportionalBatch?.waterMl ?? waterForAmounts(practicalAmounts, recipe))
            : recipe.waterMl * draft.scaleFactor) / 10,
        ) * 10,
    },
    creatineG: recipe.creatineG,
    sweetener: { mode: draft.sweetener, ...sweetener, practicalHoneyG: honeyG },
  };
  const id = createHash("sha256")
    .update(JSON.stringify([draft.sourceDate, targetDate, draft.recipeId, fullBatch, draft.nightPercent]))
    .digest("hex");
  const name = `${recipe.name}${amounts ? " adaptive" : ""}`;
  return {
    id,
    sourceDate: draft.sourceDate,
    targetDate,
    recipeId: draft.recipeId,
    definition: { draft, config },
    fraction: (100 - draft.nightPercent) / 100,
    nutrition: portions.morning,
    fullBatch,
    nightPortion: {
      fraction: draft.nightPercent / 100,
      percent: draft.nightPercent,
      nutrition: portions.night,
      creatineG: round((recipe.creatineG * draft.nightPercent) / 100),
    },
    morningCarryover: {
      fraction: (100 - draft.nightPercent) / 100,
      percent: 100 - draft.nightPercent,
      targetDate,
      nutrition: portions.morning,
      creatineG: round((recipe.creatineG * (100 - draft.nightPercent)) / 100),
    },
    nightMealLog: {
      date: draft.sourceDate,
      meal: "dinner" as const,
      name: `${name} (night portion)`,
      ...portions.night,
      idempotencyKey: `gainer:${id}:night`,
      confirm: false,
    },
    morningCarryoverMealLog: {
      date: targetDate,
      meal: "breakfast" as const,
      name: `${name} (carryover from ${draft.sourceDate})`,
      ...portions.morning,
      idempotencyKey: `gainer:${id}:morning`,
      confirm: false,
    },
  };
}
export type CarryoverPlan = ReturnType<typeof makeCarryoverPlan>;

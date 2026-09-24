import { type Macros, macroKeys, round } from "../nutrition.ts";
import { legacyRuntimeRecipe, type ProfileIngredientId, type RuntimeRecipe } from "./profiles.ts";
import type { RecipeAmounts } from "./recipe.ts";

export const scaleMacros = (value: Macros, scale: number): Macros => ({
  caloriesKcal: value.caloriesKcal * scale,
  proteinG: value.proteinG * scale,
  carbsG: value.carbsG * scale,
  fatG: value.fatG * scale,
});
export const roundedMacros = (value: Macros): Macros => ({
  caloriesKcal: round(value.caloriesKcal),
  proteinG: round(value.proteinG),
  carbsG: round(value.carbsG),
  fatG: round(value.fatG),
});

export function quantity(amounts: RecipeAmounts, id: ProfileIngredientId): number {
  const value = amounts[id];
  if (value === undefined || !Number.isFinite(value)) throw new Error(`Missing or invalid active quantity: ${id}`);
  return value;
}

export function amountsNutrition(amounts: RecipeAmounts, sweetener: Macros, recipe = legacyRuntimeRecipe()): Macros {
  const total = { ...sweetener };
  for (const i of recipe.ingredients)
    if (i.nutrition) for (const key of macroKeys) total[key] += (i.nutrition[key] * quantity(amounts, i.id)) / i.amount;
  return roundedMacros(total);
}

export function drySolidsG(amounts: RecipeAmounts, recipe = legacyRuntimeRecipe()) {
  return recipe.ingredients.reduce<number>(
    (sum, i) => sum + (i.unit === "g" ? quantity(amounts, i.id) : 0),
    recipe.creatineG,
  );
}

export function waterForAmounts(amounts: RecipeAmounts, recipe: RuntimeRecipe) {
  if (recipe.waterMode === "legacy") return drySolidsG(amounts, recipe) * recipe.adaptive.waterMlPerDryGram;
  // Structural powder -> water -> dairy. Creatine is a fixed additive, not a structural powder.
  return (
    recipe.ingredients.reduce(
      (sum, i) =>
        sum + (i.unit === "g" && !(i.id === "anchor" && recipe.anchorWaterRatio) ? quantity(amounts, i.id) : 0),
      0,
    ) * recipe.adaptive.waterMlPerDryGram
  );
}

export function scaledAmounts(scale: number, recipe: RuntimeRecipe): RecipeAmounts {
  const amounts = Object.fromEntries(recipe.ingredients.map((i) => [i.id, Math.round(i.amount * scale)]));
  if (recipe.anchorWaterRatio)
    amounts.anchor = Math.round((waterForAmounts(amounts, recipe) * recipe.anchorWaterRatio.gramsPer100MlWater) / 100);
  return amounts;
}

export function anchorRange(amounts: RecipeAmounts, recipe: RuntimeRecipe) {
  const ratio = recipe.anchorWaterRatio;
  if (!ratio) return null;
  const water = waterForAmounts(amounts, recipe);
  return {
    min: Math.max(0, Math.ceil((water * ratio.min) / 100 - 1e-9)),
    max: Math.floor((water * ratio.max) / 100 + 1e-9),
  };
}

export function fitsProfile(amounts: RecipeAmounts, nutrition: Macros, recipe: RuntimeRecipe) {
  if (recipe.profileId === "legacy_v1") return true;
  const dairy = anchorRange(amounts, recipe);
  return (
    recipe.ingredients.every((i) => {
      const value = quantity(amounts, i.id),
        bounds = recipe.adaptive.bounds[i.id];
      if (!bounds || !Number.isInteger(value) || value < 0) return false;
      if (i.id === "anchor" && dairy) return value >= dairy.min && value <= dairy.max;
      return (
        value >= Math.ceil(i.amount * bounds.minFactor - 1e-9) &&
        value <= Math.floor(i.amount * bounds.maxFactor + 1e-9)
      );
    }) &&
    drySolidsG(amounts, recipe) <= recipe.adaptive.maxDrySolidsG &&
    nutrition.caloriesKcal <= recipe.adaptive.maxBatchCaloriesKcal
  );
}

// Shared by optimization, output and logging: no separate rounded-nutrition model.
export function portionNutrition(
  scale: number,
  sweetener: Macros,
  practicalSweetener: Macros,
  recipe = legacyRuntimeRecipe(),
) {
  const exact = scaleMacros(recipe.baseNutrition, scale);
  const practical = { ...practicalSweetener };
  for (const key of macroKeys) exact[key] += sweetener[key];
  const amounts = scaledAmounts(scale, recipe);
  for (const ingredient of recipe.ingredients)
    if (ingredient.nutrition)
      for (const key of macroKeys)
        practical[key] += (ingredient.nutrition[key] * quantity(amounts, ingredient.id)) / ingredient.amount;
  return { exact: roundedMacros(exact), practical: roundedMacros(practical) };
}

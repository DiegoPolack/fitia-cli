import { type Macros, macroKeys, round } from "../nutrition.ts";
import { baseMixNutrition, type GainerAmounts, gainerRecipe } from "./recipe.ts";

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

export function amountsNutrition(amounts: GainerAmounts, sweetener: Macros): Macros {
  const total = { ...sweetener };
  for (const i of gainerRecipe.ingredients)
    if (i.nutrition) for (const key of macroKeys) total[key] += (i.nutrition[key] * amounts[i.id]) / i.amount;
  return roundedMacros(total);
}

export function drySolidsG(amounts: GainerAmounts) {
  return gainerRecipe.ingredients.reduce<number>(
    (sum, i) => sum + (i.unit === "g" ? amounts[i.id] : 0),
    gainerRecipe.creatineG,
  );
}

// Shared by optimization, output and logging: no separate rounded-nutrition model.
export function portionNutrition(scale: number, sweetener: Macros, practicalSweetener: Macros) {
  const exact = scaleMacros(baseMixNutrition, scale);
  const practical = { ...practicalSweetener };
  for (const key of macroKeys) exact[key] += sweetener[key];
  for (const ingredient of gainerRecipe.ingredients)
    if (ingredient.nutrition)
      for (const key of macroKeys)
        practical[key] += (ingredient.nutrition[key] * Math.round(ingredient.amount * scale)) / ingredient.amount;
  return { exact: roundedMacros(exact), practical: roundedMacros(practical) };
}

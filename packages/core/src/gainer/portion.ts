import { type Macros, macroKeys, round } from "../nutrition.ts";
import { baseMixNutrition, gainerRecipe } from "./recipe.ts";

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

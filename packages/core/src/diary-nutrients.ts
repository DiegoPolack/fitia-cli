import { invalidResponse } from "./errors.ts";

const macroKeys = ["caloriesKcal", "proteinG", "carbsG", "fatG"] as const;
type MaybeMacros = Record<(typeof macroKeys)[number], number | null>;
function round(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalidResponse();
  return Math.round(value * 1e6) / 1e6;
}

const sourceKeys = ["calories", "proteins", "carbs", "fats"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonnegative(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 1e9) invalidResponse();
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positive(value: unknown): number | null {
  const parsed = nonnegative(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function decimal(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  return nonnegative(Number(value));
}

function selectedMetricServing(item: Record<string, unknown>): number | null {
  if (!Array.isArray(item.servings)) return null;
  const selected = item.servings.filter((value) => record(value)?.isSelected === true);
  if (selected.length !== 1) return null;
  const serving = record(selected[0]);
  if (!serving || (serving.unit !== "g" && serving.unit !== "ml")) return null;
  return positive(serving.size);
}

function foodMacros(item: Record<string, unknown>): MaybeMacros {
  const selected = Array.isArray(item.servings) ? item.servings.filter((s) => record(s)?.isSelected === true) : [];
  const serving = selected.length === 1 ? record(selected[0]) : null;
  // Fitia's single nominal serving uses zero (normalized search output: null)
  // instead of a metric weight. Its nutrient map contains totals per serving.
  if (
    serving &&
    Array.isArray(item.servings) &&
    item.servings.length === 1 &&
    (serving.size === 0 || serving.size === null) &&
    item.factor === 1
  ) {
    const count = decimal(item.selectedNumberOfServingsRaw);
    const nutrients = record(item.nutrients);
    return Object.fromEntries(
      macroKeys.map((key, index) => {
        const n = record(nutrients?.[["calories", "protein", "carbs", "fat"][index]!]);
        const value = n?.unit === (index === 0 ? "kcal" : "g") ? nonnegative(n.size) : null;
        return [key, value === null || count === null ? null : round(value * count)];
      }),
    ) as MaybeMacros;
  }
  const servingSize = selectedMetricServing(item);
  const servings = decimal(item.selectedNumberOfServingsRaw);
  const factor = positive(item.factor);
  const sameCookingState =
    typeof item.cookingState === "string" &&
    typeof item.selectedCookingState === "string" &&
    item.cookingState === item.selectedCookingState;
  const cookingConversionKnown =
    factor !== null &&
    (factor === 1 || (typeof item.cookingState === "string" && typeof item.selectedCookingState === "string"));
  // A stored factor alone does not request a cooking conversion. Historical
  // foods can retain a yield factor while neither cooking state is present.
  const noConversion =
    nonnegative(item.factor) !== null && item.cookingState == null && item.selectedCookingState == null;
  const effectiveFactor = noConversion ? 1 : cookingConversionKnown ? (sameCookingState ? 1 : factor) : null;
  const multiplier =
    servingSize !== null && servings !== null && effectiveFactor !== null
      ? (servingSize * servings) / effectiveFactor
      : null;
  return Object.fromEntries(
    macroKeys.map((key, index) => {
      const nutrient = nonnegative(item[sourceKeys[index]!]);
      return [key, nutrient === null || multiplier === null ? null : round(nutrient * multiplier)];
    }),
  ) as MaybeMacros;
}

function recipeMacros(item: Record<string, unknown>): MaybeMacros {
  const perServing = record(item.macros_per_serving);
  if (perServing) {
    const count = decimal(item.selectedNumberOfServingsRaw);
    return Object.fromEntries(
      macroKeys.map((key, index) => {
        const value = nonnegative(perServing[["calories", "protein", "carbs", "fat"][index]!]);
        return [key, count === null || value === null ? null : round(value * count)];
      }),
    ) as MaybeMacros;
  }
  const foods = record(item.foods);
  const servings = decimal(item.selectedNumberOfServingsRaw);
  const servingsPerRecipe = positive(item.servingsPerRecipe);
  if (
    !foods ||
    Object.keys(foods).length === 0 ||
    Object.keys(foods).length > 500 ||
    servings === null ||
    servingsPerRecipe === null
  )
    return nullMacros();
  const totals: MaybeMacros = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const rawFood of Object.values(foods)) {
    const food = record(rawFood);
    const resolved = food ? foodMacros(food) : nullMacros();
    for (const key of macroKeys) {
      if (resolved[key] === null) totals[key] = null;
      else if (totals[key] !== null) totals[key] = round(totals[key] + resolved[key]);
    }
  }
  const portion = servings / servingsPerRecipe;
  for (const key of macroKeys) if (totals[key] !== null) totals[key] = round(totals[key] * portion);
  return totals;
}

function quickMacros(item: Record<string, unknown>): MaybeMacros {
  return Object.fromEntries(macroKeys.map((key, index) => [key, nonnegative(item[sourceKeys[index]!])])) as MaybeMacros;
}

function nullMacros(): MaybeMacros {
  return { caloriesKcal: null, proteinG: null, carbsG: null, fatG: null };
}

/** Resolve only serving-total structures verified against Fitia's daily aggregate. */
export function diaryEntryMacros(value: unknown): MaybeMacros {
  const item = record(value);
  if (!item) return nullMacros();
  if (item.type === "2") return quickMacros(item);
  if (item.type === "0") return foodMacros(item);
  if (item.type === "1") return recipeMacros(item);
  return nullMacros();
}

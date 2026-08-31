import { invalidResponse, object } from "./errors.ts";

export const macroKeys = ["caloriesKcal", "proteinG", "carbsG", "fatG"] as const;
export type Macros = Record<(typeof macroKeys)[number], number>;
export type MaybeMacros = Record<(typeof macroKeys)[number], number | null>;
const sourceKeys = ["calories", "proteins", "carbs", "fats"] as const;
const names = ["breakfast", "snack-1", "lunch", "snack-2", "dinner"];
export const round = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalidResponse();
  return Math.round(value * 1e6) / 1e6;
};
export const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export const emptyMacros = (): Macros => ({ caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
export function difference(goals: MaybeMacros, consumed: MaybeMacros): MaybeMacros {
  return Object.fromEntries(
    macroKeys.map((key) => [
      key,
      goals[key] === null || consumed[key] === null ? null : round(goals[key] - consumed[key]),
    ]),
  ) as MaybeMacros;
}
export function decodeFields(fields: Record<string, any>): Record<string, any> {
  function decode(v: any): any {
    const value = object(v);
    if (value.mapValue) return decodeFields(object(object(value.mapValue).fields ?? {}));
    if (value.arrayValue) {
      const values = object(value.arrayValue).values ?? [];
      if (!Array.isArray(values)) invalidResponse();
      return values.map(decode);
    }
    if (typeof value.integerValue === "string" && /^-?\d+$/.test(value.integerValue)) return Number(value.integerValue);
    return value.doubleValue ?? value.stringValue ?? value.booleanValue ?? value.timestampValue ?? null;
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));
}
function goals(value: Record<string, any>): MaybeMacros {
  return {
    caloriesKcal: amount(value.targetCalories),
    proteinG: amount(value.targetProteins),
    carbsG: amount(value.targetCarbs),
    fatG: amount(value.targetFats),
  };
}

export function summarizeDay(progress: Record<string, any>, date: string, updateTime: string) {
  const unknownEntries: { mealId: string; itemId: string; name: string; reason: string }[] = [];
  let eatenEntries = 0,
    plannedEntries = 0,
    unknownStateEntries = 0;
  const meals = Object.entries(object(progress.meals)).map(([id, raw]) => {
    const meal = object(raw),
      knownConsumed = emptyMacros(),
      consumed: MaybeMacros = emptyMacros();
    for (const [itemId, rawItem] of Object.entries(object(meal.mealItems))) {
      const item = object(rawItem);
      if (item.isEaten === false) {
        plannedEntries++;
        continue;
      }
      const unknownState = item.isEaten !== true;
      if (unknownState) unknownStateEntries++;
      else eatenEntries++;
      const missing: string[] = [];
      macroKeys.forEach((key, index) => {
        const value = item.type === "2" && !unknownState ? amount(item[sourceKeys[index]!]) : null;
        if (value === null) {
          consumed[key] = null;
          missing.push(key);
        } else {
          knownConsumed[key] += value;
          if (consumed[key] !== null) consumed[key] += value;
        }
      });
      if (missing.length)
        unknownEntries.push({
          mealId: id,
          itemId,
          name: typeof item.name === "string" ? item.name : "Unknown entry",
          reason: unknownState
            ? "Unknown eaten state"
            : item.type !== "2"
              ? "Unverified food or recipe serving totals"
              : `Missing totals: ${missing.join(", ")}`,
        });
    }
    macroKeys.forEach((key) => {
      knownConsumed[key] = round(knownConsumed[key]);
      if (consumed[key] !== null) consumed[key] = round(consumed[key]);
    });
    const target = goals(meal);
    return {
      id,
      name: Number.isInteger(meal.typeID) ? (names[meal.typeID as number] ?? "unknown") : "unknown",
      goals: target,
      consumed,
      knownConsumed,
      remaining: difference(target, consumed),
    };
  });
  const knownConsumed = emptyMacros(),
    consumed: MaybeMacros = emptyMacros();
  for (const meal of meals)
    for (const key of macroKeys) {
      knownConsumed[key] += meal.knownConsumed[key];
      if (meal.consumed[key] === null) consumed[key] = null;
      else if (consumed[key] !== null) consumed[key] += meal.consumed[key];
    }
  macroKeys.forEach((key) => {
    knownConsumed[key] = round(knownConsumed[key]);
    if (consumed[key] !== null) consumed[key] = round(consumed[key]);
  });
  const serverCalories = amount(progress.consumedCalories);
  const calorieCheck =
    serverCalories === null || consumed.caloriesKcal === null
      ? "unavailable"
      : Math.abs(serverCalories - consumed.caloriesKcal) <= 0.01
        ? "matches"
        : "mismatch";
  consumed.caloriesKcal = serverCalories === null ? null : round(serverCalories);
  const complete = unknownEntries.length === 0 && calorieCheck === "matches";
  const cached = progress.nutrientsProgress;
  const cachedKeys = ["calories", "protein", "carbs", "fat"];
  const cachedNutrientsStatus =
    cached == null
      ? "absent"
      : !complete
        ? "unverified"
        : macroKeys.every(
              (key, i) =>
                amount(object(cached)[cachedKeys[i]!]) !== null &&
                Math.abs(cached[cachedKeys[i]!] - consumed[key]!) <= 0.01,
            )
          ? "matches"
          : "stale";
  const warnings: string[] = [];
  if (unknownEntries.length)
    warnings.push(
      "Some eaten entries have unverified totals. Missing consumed and remaining macros are null; knownConsumed is only the known subtotal.",
    );
  if (calorieCheck !== "matches")
    warnings.push(
      "The server calorie aggregate cannot be reconciled with all eaten entries. Automatic suggestion budgeting is disabled.",
    );
  if (cachedNutrientsStatus === "stale")
    warnings.push("Fitia's cached nutrient summary is stale. Consumed macros were calculated from eaten entries.");
  const target = goals(progress);
  if (macroKeys.some((key) => target[key] === null))
    warnings.push("Some daily goals are unavailable; no replacement targets were invented.");
  return {
    date,
    updateTime,
    goals: target,
    consumed,
    remaining: difference(target, consumed),
    knownConsumed,
    meals,
    coverage: {
      complete,
      eatenEntries,
      plannedEntries,
      unknownStateEntries,
      unknownEntries,
      calorieCheck,
      cachedNutrientsStatus,
    },
    warnings,
  };
}
export type DaySummary = ReturnType<typeof summarizeDay>;

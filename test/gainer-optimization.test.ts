import { expect, test } from "bun:test";
import { summarizeDay } from "@fitia/core";
import { calculateGainer } from "@fitia/core/gainer/calculator";
import { GREEN_RANGE_LOWER, GREEN_RANGE_UPPER } from "@fitia/core/gainer/optimization";
import { baseMixNutrition, defaultGainerConfig, gainerRecipe, type SweetenerMode } from "@fitia/core/gainer/recipe";
import { type Macros, macroKeys, round } from "@fitia/core/nutrition";

const date = "2026-09-14";
const targets: Macros = { caloriesKcal: 3000, proteinG: 110, carbsG: 400, fatG: 90 };
function day(consumed: Macros, goals = targets) {
  return summarizeDay(
    {
      targetCalories: goals.caloriesKcal,
      targetProteins: goals.proteinG,
      targetCarbs: goals.carbsG,
      targetFats: goals.fatG,
      consumedCalories: consumed.caloriesKcal,
      meals: {
        dinner: {
          typeID: 4,
          mealItems: {
            eaten: {
              type: "2",
              isEaten: true,
              name: "Synthetic pre-drink day",
              calories: consumed.caloriesKcal,
              proteins: consumed.proteinG,
              carbs: consumed.carbsG,
              fats: consumed.fatG,
            },
          },
        },
      },
    },
    date,
    "2026-09-14T22:00:00Z",
  );
}
function optimal(consumed: Macros, goals = targets, sweetener: SweetenerMode = "none") {
  return calculateGainer({ date, mode: "fitia_optimal", sweetener }, defaultGainerConfig(), day(consumed, goals));
}
function requireDrink(result: ReturnType<typeof optimal>) {
  if (!("nutrition" in result)) throw new Error(`Expected drink: ${result.reason}`);
  return result;
}

test("clear calorie and macro deficits produce a beneficial serving", () => {
  const result = requireDrink(optimal({ caloriesKcal: 1800, proteinG: 70, carbsG: 200, fatG: 50 }));
  expect(result.optimization!.improvedMetrics).toEqual(macroKeys);
  expect(result.optimization!.score.after).toBeLessThan(result.optimization!.score.before);
  expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeLessThanOrEqual(3300);
});

test.each([2750, 2800, 3050])("calories already green at %s can still justify carbs", (caloriesKcal) => {
  const result = requireDrink(optimal({ caloriesKcal, proteinG: 120, carbsG: 320, fatG: 90 }));
  expect(result.optimization!.before).toMatchObject({ caloriesKcal: "green", carbsG: "low" });
  expect(result.optimization!.improvedMetrics).toContain("carbsG");
  expect(result.optimization!.after.caloriesKcal).toBe("green");
  expect(result.optimization!.maxAdditionalCaloriesKcal).toBe(3300 - caloriesKcal);
  expect(result.practicalNutrition.caloriesKcal).toBeGreaterThan(0);
});

test.each(["none", "honey_only", "both", "stevia_only"] as const)("all green prefers no drink with %s", (sweetener) => {
  const result = optimal({ caloriesKcal: 2750, proteinG: 105, carbsG: 365, fatG: 85 }, targets, sweetener);
  expect(result).toMatchObject({
    status: "not_recommended",
    drink: null,
    baseMix: { scaleFactor: 0 },
    suggestedMealLog: null,
    optimization: {
      outcome: "not_needed",
      before: { caloriesKcal: "green", proteinG: "green", carbsG: "green", fatG: "green" },
    },
  });
  expect("creatineG" in result).toBe(false);
});

test("near the calorie upper limit only allows a small serving", () => {
  const result = optimal({ caloriesKcal: 3290, proteinG: 120, carbsG: 320, fatG: 90 });
  expect(result.optimization!.maxAdditionalCaloriesKcal).toBe(10);
  if ("nutrition" in result) {
    expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(10);
    expect(result.nutrition.caloriesKcal).toBeLessThanOrEqual(10);
  } else expect(result.suggestedMealLog).toBeNull();
});

test("already high protein gives no reward but does not block useful carbs", () => {
  const result = requireDrink(optimal({ caloriesKcal: 2800, proteinG: 150, carbsG: 320, fatG: 90 }));
  expect(result.optimization!.before.proteinG).toBe("high");
  expect(result.optimization!.after.proteinG).toBe("high");
  expect(result.optimization!.after.carbsG).toBe("green");
  expect(result.optimization!.improvedMetrics).not.toContain("proteinG");
  expect(result.optimization!.score.penalties.proteinG).toBeGreaterThan(0);
});

test("unfixable carbs stop at the calorie green ceiling and explain the compromise", () => {
  const result = requireDrink(optimal({ caloriesKcal: 3100, proteinG: 105, carbsG: 100, fatG: 81 }));
  expect(result.optimization!.after.carbsG).toBe("low");
  expect(result.optimization!.outcome).toBe("limited_by_calories");
  expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeLessThanOrEqual(3300);
  expect(result.optimization!.score.after).toBeLessThan(result.optimization!.score.before);
});

test("protein and fat deficits matter even with calories and carbs green", () => {
  for (const consumed of [
    { caloriesKcal: 2750, proteinG: 85, carbsG: 365, fatG: 81 },
    { caloriesKcal: 2750, proteinG: 105, carbsG: 365, fatG: 72 },
  ]) {
    const result = requireDrink(optimal(consumed));
    expect(result.optimization!.improvedMetrics).toContain(consumed.proteinG === 85 ? "proteinG" : "fatG");
    expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeLessThanOrEqual(3300);
  }
});

test("all metrics high selects zero; honey alone cannot improve the baseline", () => {
  expect(optimal({ caloriesKcal: 3400, proteinG: 150, carbsG: 450, fatG: 110 }, targets, "honey_only")).toMatchObject({
    status: "not_recommended",
    baseMix: { scaleFactor: 0 },
    suggestedMealLog: null,
    optimization: { outcome: "not_beneficial", score: { extraCalories: 0 } },
  });
  // Protein deficit is too small to justify the extra honey/carbs when calories have only 5 kcal headroom.
  const result = optimal({ caloriesKcal: 3295, proteinG: 98, carbsG: 439, fatG: 98 });
  expect(result.baseMix.scaleFactor).toBe(0);
});

test("stops at the first practical green serving rather than the central target", () => {
  const consumed = { caloriesKcal: 2300, proteinG: 90, carbsG: 300, fatG: 70 };
  const result = requireDrink(optimal(consumed));
  expect(result.optimization!.outcome).toBe("all_green");
  expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeLessThan(2800);
  expect(result.practicalNutrition.caloriesKcal).toBeLessThan(3000 - consumed.caloriesKcal);
  // An independently enumerated finer grid cannot provide a smaller all-green practical portion.
  for (let scale = 0.001; scale < result.baseMix.scaleFactor; scale += 0.001) {
    const nutrition = Object.fromEntries(
      macroKeys.map((key) => [
        key,
        gainerRecipe.ingredients.reduce(
          (sum, i) => sum + ((i.nutrition?.[key] ?? 0) * Math.round(i.amount * scale)) / i.amount,
          0,
        ),
      ]),
    ) as Macros;
    const allGreen = macroKeys.every(
      (key) =>
        consumed[key] + nutrition[key] >= targets[key] * GREEN_RANGE_LOWER - 1e-6 &&
        consumed[key] + nutrition[key] <= targets[key] * GREEN_RANGE_UPPER + 1e-6,
    );
    if (nutrition.caloriesKcal < result.practicalNutrition.caloriesKcal - 1e-6) expect(allGreen).toBe(false);
  }
});

test.each(["honey_only", "both", "none", "stevia_only"] as const)(
  "practical quantities, macros and log payload agree for %s",
  (sweetener) => {
    const result = requireDrink(
      optimal(
        { caloriesKcal: 1983, proteinG: 148, carbsG: 185, fatG: 71 },
        { ...targets, caloriesKcal: 2940, fatG: 98 },
        sweetener,
      ),
    );
    const sums: Macros = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    for (const ingredient of result.ingredients) {
      const amount = "practicalG" in ingredient ? ingredient.practicalG : ingredient.practicalMl;
      expect(Number.isInteger(amount)).toBe(true);
      const recipe = gainerRecipe.ingredients.find((i) => i.id === ingredient.id)!;
      for (const key of macroKeys) sums[key] += ((recipe.nutrition?.[key] ?? 0) * amount) / recipe.amount;
    }
    for (const key of macroKeys) {
      sums[key] += (result.sweetener.practicalHoneyG * result.sweetener.honeyProfile.per100G[key]) / 100;
      expect(result.practicalNutrition[key]).toBe(round(sums[key]));
      expect(result.suggestedMealLog[key]).toBe(result.practicalNutrition[key]);
    }
    expect(result.water.practicalMl % 10).toBe(0);
    expect(result.creatineG).toBe(5);
    expect(result.optimization!.practicalValidated).toBe(true);
  },
);

test("rounding is checked at a calorie boundary, not just warned about", () => {
  const result = optimal({ caloriesKcal: 3292, proteinG: 105, carbsG: 320, fatG: 81 });
  // First rounded serving is 1 g oats + 1 g Anchor: it cannot fit an 8 kcal budget.
  expect(result.baseMix.scaleFactor).toBe(0);
  expect(result.optimization!.maxAdditionalCaloriesKcal).toBe(8);
});

test("calories mode retains the explicit objective even when every metric is green", () => {
  const summary = day({ caloriesKcal: 2750, proteinG: 105, carbsG: 365, fatG: 85 });
  const result = requireDrink(
    calculateGainer(
      { date, mode: "calories", sweetener: "none", targetCaloriesKcal: 500 },
      defaultGainerConfig(),
      summary,
    ),
  );
  expect(result.nutrition.caloriesKcal).toBe(500);
  expect(result.baseMix.scaleFactor).toBeCloseTo(500 / baseMixNutrition.caloriesKcal, 10);
  expect(result.optimization).toBeUndefined();
});

test("provided September 14 approximation is evaluated without hardcoding its portion", () => {
  const goals = { caloriesKcal: 2940, proteinG: 110, carbsG: 400, fatG: 98 };
  const consumed = { caloriesKcal: 1983, proteinG: 148, carbsG: 185, fatG: 71 };
  const result = requireDrink(optimal(consumed, goals, "honey_only"));
  expect(result.greenRanges!.caloriesKcal).toEqual({ target: 2940, min: 2646, max: 3234 });
  expect(result.optimization!.before).toEqual({ caloriesKcal: "low", proteinG: "high", carbsG: "low", fatG: "low" });
  expect(result.optimization!.improvedMetrics).toEqual(["caloriesKcal", "carbsG", "fatG"]);
  expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeLessThanOrEqual(3234);
  expect(result.optimization!.score.after).toBeLessThan(result.optimization!.score.before);
  expect(result.nutrition.caloriesKcal).not.toBe(goals.caloriesKcal - consumed.caloriesKcal);
});

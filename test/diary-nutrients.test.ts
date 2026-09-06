import { expect, test } from "bun:test";
import { diaryEntryMacros, summarizeDay } from "@fitia/core";

const serving = (size: number, unit = "g") => [{ size, unit, type: "number", isSelected: true }];

function food(overrides: Record<string, unknown> = {}) {
  return {
    type: "0",
    calories: 2,
    proteins: 0.1,
    carbs: 0.2,
    fats: 0.05,
    factor: 1,
    selectedNumberOfServingsRaw: "2.0",
    servings: serving(50),
    ...overrides,
  };
}

test("food serving totals use the selected metric serving and numeric count", () => {
  expect(diaryEntryMacros(food())).toEqual({ caloriesKcal: 200, proteinG: 10, carbsG: 20, fatG: 5 });
});

test("cooking factor applies only when the selected cooking state differs", () => {
  expect(
    diaryEntryMacros(
      food({
        factor: 0.75,
        cookingState: "Raw",
        selectedCookingState: "Cooked",
        selectedNumberOfServingsRaw: "1.0",
        servings: serving(75),
      }),
    ).caloriesKcal,
  ).toBe(200);
  expect(
    diaryEntryMacros(
      food({
        factor: 2.5,
        cookingState: "Cooked",
        selectedCookingState: "Cooked",
        selectedNumberOfServingsRaw: "1.0",
        servings: serving(100),
      }),
    ).caloriesKcal,
  ).toBe(200);
});

test("recipe totals sum ingredients and scale by the requested recipe serving", () => {
  const recipe = {
    type: "1",
    selectedNumberOfServingsRaw: "0.5",
    servingsPerRecipe: 2,
    servings: serving(175),
    foods: {
      first: food({ selectedNumberOfServingsRaw: "1.0", servings: serving(100) }),
      second: food({
        calories: 4,
        proteins: 0.6,
        carbs: 0.2,
        fats: 0.4,
        factor: 0.75,
        cookingState: "Raw",
        selectedCookingState: "Cooked",
        selectedNumberOfServingsRaw: "1.0",
        servings: serving(75),
      }),
    },
  };
  expect(diaryEntryMacros(recipe)).toEqual({ caloriesKcal: 150, proteinG: 17.5, carbsG: 10, fatG: 11.25 });
});

test("verified food and recipe totals reconcile day calories and cached macros", () => {
  const recipe = {
    type: "1",
    name: "Synthetic recipe",
    isEaten: true,
    selectedNumberOfServingsRaw: "1.0",
    servingsPerRecipe: 1,
    servings: serving(175),
    foods: {
      sameState: food({
        calories: 1,
        selectedNumberOfServingsRaw: "1.0",
        servings: serving(100),
        factor: 2.5,
        cookingState: "Cooked",
        selectedCookingState: "Cooked",
      }),
      converted: food({
        calories: 2,
        proteins: 0.3,
        carbs: 0.1,
        fats: 0.2,
        selectedNumberOfServingsRaw: "1.0",
        servings: serving(75),
        factor: 0.75,
        cookingState: "Raw",
        selectedCookingState: "Cooked",
      }),
    },
  };
  const progress = {
    targetCalories: 1000,
    targetProteins: 100,
    targetCarbs: 100,
    targetFats: 100,
    consumedCalories: 500,
    nutrientsProgress: { calories: 500, protein: 50, carbs: 50, fat: 30 },
    meals: {
      breakfast: {
        typeID: 0,
        targetCalories: 500,
        targetProteins: 50,
        targetCarbs: 50,
        targetFats: 50,
        mealItems: { food: { ...food(), name: "Synthetic food", isEaten: true }, recipe },
      },
    },
  };
  const result = summarizeDay(progress, "2026-09-05", "2026-09-05T00:00:00Z");
  expect(result.consumed).toEqual({ caloriesKcal: 500, proteinG: 50, carbsG: 50, fatG: 30 });
  expect(result.remaining).toEqual({ caloriesKcal: 500, proteinG: 50, carbsG: 50, fatG: 70 });
  expect(result.knownConsumed).toEqual(result.consumed);
  expect(result.coverage).toMatchObject({
    complete: true,
    unknownEntries: [],
    calorieCheck: "matches",
    cachedNutrientsStatus: "matches",
  });
  expect(result.warnings).toEqual([]);
});

test.each([
  ["missing selected serving", food({ servings: [{ size: 50, unit: "g", isSelected: false }] })],
  ["ambiguous selected serving", food({ servings: [...serving(50), ...serving(100)] })],
  ["unsupported selected unit", food({ servings: serving(1, "oz") })],
  ["invalid serving count", food({ selectedNumberOfServingsRaw: "1,5" })],
  ["missing cooking factor", food({ factor: undefined })],
  ["unknown cooking conversion", food({ factor: 0.75 })],
  ["empty recipe", { type: "1", selectedNumberOfServingsRaw: "1.0", servingsPerRecipe: 1, foods: {} }],
  ["unsupported type", { type: "3", calories: 10, proteins: 1, carbs: 1, fats: 1 }],
])("%s fails closed instead of inventing totals", (_name, entry) => {
  expect(diaryEntryMacros(entry)).toEqual({ caloriesKcal: null, proteinG: null, carbsG: null, fatG: null });
});

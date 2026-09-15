import { expect, test } from "bun:test";
import { summarizeDay } from "@fitia/core";
import { calculateGainer, type GainerInput } from "@fitia/core/gainer/calculator";
import {
  baseMixCostPen,
  baseMixNutrition,
  defaultGainerConfig,
  type GainerConfig,
  gainerRecipe,
} from "@fitia/core/gainer/recipe";

const date = "2026-09-13";
export function gainerDay() {
  return summarizeDay(
    {
      targetCalories: 2500,
      targetProteins: 150,
      targetCarbs: 320,
      targetFats: 80,
      consumedCalories: 2000,
      meals: {
        dinner: {
          typeID: 4,
          targetCalories: 800,
          targetProteins: 50,
          targetCarbs: 100,
          targetFats: 30,
          mealItems: {
            eaten: {
              type: "2",
              name: "Synthetic daily intake",
              isEaten: true,
              calories: 2000,
              proteins: 100,
              carbs: 200,
              fats: 50,
            },
          },
        },
      },
    },
    date,
    "2026-09-13T20:00:00Z",
  );
}
function calc(input: Partial<GainerInput> = {}, config: GainerConfig = defaultGainerConfig(), day = gainerDay()) {
  return calculateGainer({ date, mode: "calories", sweetener: "none", targetCaloriesKcal: 500, ...input }, config, day);
}
function drink(input: Partial<GainerInput> = {}, config = defaultGainerConfig(), day = gainerDay()) {
  const result = calc(input, config, day);
  if (!("nutrition" in result)) throw new Error(`Expected a drink, got ${result.status}`);
  return result;
}
test("v1 base nutrition is the ingredient sum, without honey", () => {
  expect(baseMixNutrition.caloriesKcal).toBeCloseTo(578.5, 8);
  expect(baseMixNutrition.carbsG).toBeCloseTo(85.92, 8);
  expect(baseMixNutrition.proteinG).toBeCloseTo(20.185, 8);
  expect(baseMixNutrition.fatG).toBeCloseTo(15.41, 8);
  expect(baseMixCostPen).toBeCloseTo(6.1976, 3);
  expect(drink({ targetCaloriesKcal: 578.5 }).nutrition).toEqual({
    caloriesKcal: 578.5,
    carbsG: 85.92,
    proteinG: 20.185,
    fatG: 15.41,
  });
});
test("500 kcal legacy regression retains precision and domestic whole units", () => {
  const result = drink();
  expect(result.baseMix.scaleFactor).toBeCloseTo(0.8643042351, 10);
  expect(result.nutrition.carbsG).toBeCloseTo(74.261, 3);
  expect(result.nutrition.proteinG).toBeCloseTo(17.446, 2);
  expect(result.nutrition.fatG).toBeCloseTo(13.3189, 3);
  expect(result.ingredients.map((i) => ("practicalG" in i ? i.practicalG : i.practicalMl))).toEqual([
    43, 43, 17, 9, 4, 4, 1, 3,
  ]);
  expect(result.water.exactMl).toBeCloseTo(518.582541, 5);
  expect(result.water.practicalMl).toBe(520);
  expect(result.creatineG).toBe(5);
  expect(result.cost.totalPen).toBeNull();
});
test.each([
  ["honey_only", 3, 60, 182.4, 49.44, 0],
  ["both", 2, 40, 121.6, 32.96, 2],
  ["stevia_only", 0, 0, 0, 0, 2],
  ["none", 0, 0, 0, 0, 0],
] as const)("%s is reserved before base scaling", (mode, tbsp, grams, kcal, carbs, stevia) => {
  const result = drink({ sweetener: mode });
  expect(result.sweetener).toMatchObject({ honeyTablespoons: tbsp, honeyG: grams, steviaPackets: stevia });
  expect(result.sweetener.caloriesKcal).toBeCloseTo(kcal, 8);
  expect(result.sweetener.carbsG).toBeCloseTo(carbs, 8);
  expect(result.baseMix.scaleFactor).toBeCloseTo((500 - kcal) / 578.5, 10);
  expect(result.nutrition.caloriesKcal).toBe(500);
});
test("auto uses saved inventory and does not guess unknown", () => {
  const config = defaultGainerConfig();
  expect(calc({ sweetener: "auto" }, config)).toMatchObject({
    status: "needs_input",
    options: ["both", "honey_only", "stevia_only", "none"],
    suggestedMealLog: null,
  });
  config.sweetenerInventory = "honey_only";
  expect(drink({ sweetener: "auto" }, config).sweetener.mode).toBe("honey_only");
  expect(drink({ sweetener: "none" }, config).sweetener.honeyG).toBe(0);
});
test("honey above/equal target never creates a negative or honey-only gainer", () => {
  expect(calc({ targetCaloriesKcal: 120, sweetener: "honey_only" })).toMatchObject({
    status: "sweetener_exceeds_target",
    excessCaloriesKcal: 62.4,
    baseMix: { scaleFactor: 0 },
    suggestedMealLog: null,
  });
  expect(calc({ targetCaloriesKcal: 182.4, sweetener: "honey_only" }).status).toBe("not_recommended");
  expect(calc({ targetCaloriesKcal: 0 }).status).toBe("not_recommended");
});
test("configurable honey label replaces reference without changing algorithm", () => {
  const config = defaultGainerConfig();
  config.honeyGramsPerTablespoon = 15.5;
  config.honeyProfile = {
    source: "product_label",
    label: "Synthetic honey",
    per100G: { caloriesKcal: 300, carbsG: 75, proteinG: 1, fatG: 2 },
  };
  const result = drink({ sweetener: "honey_only" }, config);
  expect(result.sweetener.honeyG).toBe(46.5);
  expect(result.sweetener.practicalHoneyG).toBe(47);
  expect(result.sweetener.caloriesKcal).toBe(139.5);
  expect(result.sweetener.fatG).toBe(0.93);
  expect(result.warnings.some((w) => w.includes("referencia estándar"))).toBe(false);
});
test("practical macros and logging match rounded ingredient amounts", () => {
  const result = drink({ sweetener: "honey_only" });
  let kcal = 182.4;
  for (const i of gainerRecipe.ingredients)
    if (i.nutrition) kcal += (i.nutrition.caloriesKcal * Math.round(i.amount * result.baseMix.scaleFactor)) / i.amount;
  expect(result.practicalNutrition.caloriesKcal).toBeCloseTo(kcal, 5);
  expect(result.suggestedMealLog).toMatchObject({ ...result.practicalNutrition, date, confirm: false });
  expect(result.exactMealLog).toMatchObject(result.nutrition);
  expect(result.practicalProjection.consumedAfter.caloriesKcal).toBeCloseTo(2000 + kcal, 5);
});
test("Fitia optimal uses green headroom without changing proportions or fixed ingredients", () => {
  const day = gainerDay();
  const result = drink(
    { mode: "fitia_optimal", targetCaloriesKcal: undefined, sweetener: "honey_only" },
    defaultGainerConfig(),
    day,
  );
  expect(result.targetCaloriesKcal).toBe(500);
  expect(result.optimization?.maxAdditionalCaloriesKcal).toBe(750);
  expect(result.nutrition.caloriesKcal).toBeLessThanOrEqual(750);
  expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(750);
  for (let index = 0; index < result.ingredients.length; index++) {
    const ingredient = result.ingredients[index]!;
    expect("exactG" in ingredient ? ingredient.exactG : ingredient.exactMl).toBeCloseTo(
      gainerRecipe.ingredients[index]!.amount * result.baseMix.scaleFactor,
      8,
    );
  }
  expect(result.sweetener.honeyTablespoons).toBe(3);
  expect(result.creatineG).toBe(5);
  expect(result.water.exactMl).toBeCloseTo(600 * result.baseMix.scaleFactor, 8);
});
test("optimal rejects explicit calorie overrides and requires complete goals", () => {
  const input = { mode: "fitia_optimal", targetCaloriesKcal: undefined, sweetener: "honey_only" } as const;
  const day = gainerDay();
  day.goals.fatG = null;
  expect(calc(input, defaultGainerConfig(), day).status).toBe("needs_input");
  expect(() => calc({ mode: "fitia_optimal" })).toThrow("requires mode=calories");
});
test("incomplete consumption is not zero; explicit calorie mode preserves null projections", () => {
  const day = gainerDay();
  day.coverage.complete = false;
  day.remaining.carbsG = null;
  day.consumed.carbsG = null;
  expect(calc({ targetCaloriesKcal: undefined }, defaultGainerConfig(), day).status).toBe("needs_input");
  expect(calc({ mode: "fitia_optimal", targetCaloriesKcal: undefined }, defaultGainerConfig(), day).status).toBe(
    "needs_input",
  );
  expect(drink({}, defaultGainerConfig(), day).projection.consumedAfter.carbsG).toBeNull();
});
test("optimal is deterministic and respects calorie green maximum across budgets", () => {
  for (const kcal of [100, 200, 500, 800, 1200])
    for (const fat of [0, 3, 15, 40])
      for (const carbs of [10, 50, 150, 300]) {
        const day = gainerDay();
        day.remaining = { caloriesKcal: kcal, fatG: fat, carbsG: carbs, proteinG: 50 };
        day.goals = { caloriesKcal: 2000 + kcal, fatG: 50 + fat, carbsG: 200 + carbs, proteinG: 150 };
        const input = { mode: "fitia_optimal", targetCaloriesKcal: undefined, sweetener: "honey_only" } as const;
        const result = calc(input, defaultGainerConfig(), day);
        expect(result).toEqual(calc(input, defaultGainerConfig(), day));
        expect(result.baseMix.scaleFactor).toBeGreaterThanOrEqual(0);
        if ("nutrition" in result) {
          const maximum = result.greenRanges!.caloriesKcal.max - 2000;
          expect(result.nutrition.caloriesKcal).toBeLessThanOrEqual(maximum + 1e-6);
          expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(maximum + 1e-6);
          expect(result.optimization!.score.after).toBeLessThan(result.optimization!.score.before);
        }
      }
});

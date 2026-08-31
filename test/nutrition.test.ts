import { expect, test } from "bun:test";
import { decodeFields, summarizeDay } from "@fitia/core";
import Ajv from "ajv";
import { schema } from "../apps/cli/src/contract/index.ts";

const date = "2026-08-30",
  time = "2026-08-30T21:49:05.768551Z";
function progress() {
  return {
    targetCalories: 1681.625,
    targetProteins: 140.4,
    targetCarbs: 153.884375,
    targetFats: 56.054167,
    consumedCalories: 1394.2,
    nutrientsProgress: { calories: 662.9, protein: 10.629, carbs: 116.409, fat: 19.865 },
    meals: {
      lunch: {
        typeID: 2,
        targetCalories: 607.234,
        targetProteins: 50.7,
        targetCarbs: 55.56,
        targetFats: 20.24,
        mealItems: {
          quick: {
            type: "2",
            name: "Synthetic totals",
            isEaten: true,
            calories: 1394.2,
            proteins: 78.129,
            carbs: 163.609,
            fats: 49.165,
          },
        },
      },
      dinner: {
        typeID: 4,
        targetCalories: 420.40625,
        targetProteins: 35.1,
        targetCarbs: 38.471,
        targetFats: 14.014,
        mealItems: {},
      },
    },
  };
}
const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(
  schema().commands.find((c) => c.name === "day summary")!.data,
);
test("summary computes current eaten macros instead of stale cache, and preserves over-goal values", () => {
  const result = summarizeDay(progress(), date, time);
  expect(result.consumed).toEqual({ caloriesKcal: 1394.2, proteinG: 78.129, carbsG: 163.609, fatG: 49.165 });
  expect(result.remaining).toEqual({ caloriesKcal: 287.425, proteinG: 62.271, carbsG: -9.724625, fatG: 6.889167 });
  expect(result.coverage).toMatchObject({ complete: true, cachedNutrientsStatus: "stale", calorieCheck: "matches" });
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
});
test("planned entries never count, including unsupported food objects", () => {
  const p: any = progress();
  p.meals.dinner.mealItems.planned = { type: "0", isEaten: false, calories: 800 };
  const result = summarizeDay(p, date, time);
  expect(result.coverage.plannedEntries).toBe(1);
  expect(result.coverage.complete).toBe(true);
  expect(result.meals[1]!.consumed.caloriesKcal).toBe(0);
});
test.each(["0", "1", "3", "unexpected"])(
  "unsupported eaten type %s leaves macros unknown without losing known subtotals",
  (type) => {
    const p: any = progress();
    p.meals.dinner.mealItems.food = { type, isEaten: true, calories: 1.2 };
    const result = summarizeDay(p, date, time);
    expect(result.consumed.proteinG).toBeNull();
    expect(result.remaining.proteinG).toBeNull();
    expect(result.knownConsumed.proteinG).toBe(78.129);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.unknownEntries).toHaveLength(1);
    expect(validate(result)).toBe(true);
  },
);
test("a missing nutrient only makes that nutrient unknown", () => {
  const p: any = progress();
  delete p.meals.lunch.mealItems.quick.proteins;
  const result = summarizeDay(p, date, time);
  expect(result.remaining.proteinG).toBeNull();
  expect(result.remaining.carbsG).toBe(-9.724625);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.calorieCheck).toBe("matches");
});
test("unknown eaten state is not silently excluded or treated as eaten", () => {
  const p: any = progress();
  delete p.meals.lunch.mealItems.quick.isEaten;
  const result = summarizeDay(p, date, time);
  expect(result.coverage.unknownStateEntries).toBe(1);
  expect(result.coverage.eatenEntries).toBe(0);
  expect(result.consumed.fatG).toBeNull();
  expect(result.knownConsumed.fatG).toBe(0);
});
test("conflicting calorie aggregate blocks completeness and never silently rewrites a diary", () => {
  const p = progress();
  p.consumedCalories = 123;
  const before = structuredClone(p),
    result = summarizeDay(p, date, time);
  expect(result.coverage.calorieCheck).toBe("mismatch");
  expect(result.coverage.complete).toBe(false);
  expect(result.consumed.caloriesKcal).toBe(123);
  expect(result.knownConsumed.caloriesKcal).toBe(1394.2);
  expect(p).toEqual(before);
});
test("missing goals and negative nutrient values are unknown", () => {
  const p: any = progress();
  delete p.targetProteins;
  p.meals.lunch.mealItems.quick.carbs = -1;
  const result = summarizeDay(p, date, time);
  expect(result.goals.proteinG).toBeNull();
  expect(result.remaining.proteinG).toBeNull();
  expect(result.consumed.carbsG).toBeNull();
});
test("Firestore numbers, explicit zero, false, empty maps and arrays are decoded without truthiness errors", () => {
  expect(
    decodeFields({
      zero: { integerValue: "0" },
      flag: { booleanValue: false },
      absent: { nullValue: null },
      meals: { mapValue: {} },
      values: { arrayValue: { values: [{ integerValue: "2" }] } },
    }),
  ).toEqual({ zero: 0, flag: false, absent: null, meals: {}, values: [2] });
});
test("malformed structure and overflow cannot masquerade as an empty or complete day", () => {
  expect(() => summarizeDay({}, date, time)).toThrow();
  const p = progress();
  p.meals.lunch.mealItems.quick.calories = 1e308;
  expect(() => summarizeDay(p, date, time)).toThrow();
});

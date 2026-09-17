import { expect, test } from "bun:test";
import { quickEntryIdentity } from "@fitia/core/diary";
import { calculateGainer } from "@fitia/core/gainer/calculator";
import { type CarryoverRecord, carryoverContext, type DiarySnapshot, planningDay } from "@fitia/core/gainer/carryover";
import { defaultGainerConfig } from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { difference, emptyMacros, type Macros, macroKeys, round, summarizeDay } from "@fitia/core/nutrition";

const config = { ...defaultGainerConfig(), sweetenerInventory: "honey_only" as const };
const date = "2026-09-16";
// Approximate normal intake. Macro goals/intake are synthetic because the bug
// report supplies the calorie target, not all four of the actual day's targets.
const normal = { caloriesKcal: 1413, proteinG: 80, carbsG: 153, fatG: 50 };
function record(scaleFactor = 1.65, nightPercent = 61): CarryoverRecord {
  return {
    ...makeCarryoverPlan(
      {
        sourceDate: "2026-09-15",
        recipeId: "polack_labs_mass_gainer_v1",
        scaleFactor,
        sweetener: "honey_only",
        nightPercent,
      },
      config,
    ),
    status: "pending",
    version: "1",
    consumedEntry: null,
  };
}
function fixture(registered: CarryoverRecord[] = [], food: Macros = normal) {
  const day = summarizeDay(
    { targetCalories: 2028, targetProteins: 110, targetCarbs: 270, targetFats: 67.6, consumedCalories: 0, meals: {} },
    date,
    "same-snapshot",
  );
  const consumed = { ...food };
  for (const r of registered) for (const key of macroKeys) consumed[key] = round(consumed[key] + r.nutrition[key]);
  day.consumed = consumed;
  day.remaining = difference(day.goals, consumed);
  const diary: DiarySnapshot = {
    date,
    updateTime: day.updateTime,
    consumedCaloriesKcal: consumed.caloriesKcal,
    limitations: [],
    meals: [
      {
        id: "breakfast",
        name: "breakfast",
        typeId: 0,
        items: registered.map((r) => ({
          id: quickEntryIdentity("synthetic", date, "breakfast", r.morningCarryoverMealLog.idempotencyKey).id,
          type: "2",
          eaten: true,
          name: r.morningCarryoverMealLog.name,
          sourceId: undefined,
          sourceSubcollection: undefined,
          amount: undefined,
          ...r.nutrition,
        })),
      },
    ],
  };
  return { day, diary };
}
function calculate(records: CarryoverRecord[], registered: CarryoverRecord[], food = normal) {
  const { day, diary } = fixture(registered, food);
  const context = carryoverContext(records, day, diary, "synthetic");
  return {
    day,
    diary,
    context,
    result: calculateGainer({ date, mode: "fitia_optimal", sweetener: "none" }, config, day, context),
  };
}

test("61/39 prior-day registered carryover stays in Fitia but uses normal intake for optimization", () => {
  const r = record();
  expect(r.nightPortion.fraction).toBe(0.61);
  expect(r.fraction).toBe(0.39);
  expect(r.nutrition).toEqual({ caloriesKcal: 445.1031, proteinG: 13.039455, carbsG: 74.814675, fatG: 9.967425 });
  const { day, result, context } = calculate([r], [r]);
  const baseline = calculate([], []).result;
  expect(result.registeredConsumed.caloriesKcal).toBeCloseTo(1858.1031, 5);
  expect(result.targetCaloriesKcal).toBeCloseTo(169.8969, 5);
  expect(result.planningConsumed).toEqual(normal);
  expect(context.optimizationConsumed).toEqual(result.planningConsumed);
  expect(result.excludedCarryoverFromPlanning).toEqual(r.nutrition);
  expect(result.baseMix).toEqual(baseline.baseMix);
  expect(result.optimization).toEqual(baseline.optimization);
  if (!("practicalNutrition" in result)) throw new Error(result.reason);
  expect(result.practicalNutrition.caloriesKcal).toBeGreaterThanOrEqual(600);
  expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(620);
  for (const key of macroKeys) {
    expect(result.effectiveProjection.consumedAfter[key]).toBe(round(normal[key] + result.practicalNutrition[key]));
    expect(round(result.fitiaProjection.consumedAfter[key]! - result.effectiveProjection.consumedAfter[key]!)).toBe(
      r.nutrition[key],
    );
  }
  expect(result.fitia).toEqual(day);
  expect(result.planningBasis).toContain("2026-09-15");
  expect(result.planningBasis).toContain("445.1031");
  expect(result.configUsed).toEqual(config);
  expect(result.sweetener.mode).toBe("none");
});

test("without carryover the optimizer, projections and practical serving are unchanged", () => {
  const { day, result } = calculate([], []);
  const noContext = calculateGainer({ date, mode: "fitia_optimal", sweetener: "none" }, config, day);
  expect(result).toEqual(noContext);
  expect(result.registeredConsumed).toEqual(result.planningConsumed);
  expect(result.excludedCarryoverFromPlanning).toEqual(emptyMacros());
  if (!("practicalProjection" in result)) throw new Error(result.reason);
  expect(result.effectiveProjection).toEqual(result.practicalProjection);
  expect(result.fitiaProjection).toEqual(result.practicalProjection);
});

test("an unregistered pending portion reserves nutrition once and is not projected as registered", () => {
  const r = record();
  const { day, context, result } = calculate([r], []);
  expect(context.plannedNutrition).toEqual(r.nutrition);
  expect(context.recordedNutrition).toEqual(emptyMacros());
  expect(context.excludedCarryoverFromPlanning).toEqual(emptyMacros());
  for (const key of macroKeys) expect(result.planningConsumed[key]).toBe(round(normal[key] + r.nutrition[key]));
  expect(planningDay(planningDay(day, context), context)).toEqual(planningDay(day, context));
  if (!("practicalNutrition" in result)) throw new Error(result.reason);
  expect(result.fitiaProjection.consumedAfter.caloriesKcal).toBe(
    round(normal.caloriesKcal + result.practicalNutrition.caloriesKcal),
  );
});

test("registered same-source-day portions are not excluded by a blanket carryover subtraction", () => {
  // V1 currently creates only next-day records; retain this origin boundary for
  // any future same-day representation without modifying the persistence API.
  const r = { ...record(), sourceDate: date };
  const { result, context } = calculate([r], [r]);
  expect(context.recordedNutrition).toEqual(r.nutrition);
  expect(result.excludedCarryoverFromPlanning).toEqual(emptyMacros());
  expect(result.planningConsumed).toEqual(result.registeredConsumed);
});

test("multiple verified origins exclude only previous dates and reserve each pending portion once", () => {
  const earlier = record(),
    earlier2 = record(1.5, 61);
  const sameDay = { ...record(2, 50), sourceDate: date };
  const pending = record(2.1, 50);
  const cancelled = { ...record(1.4, 61), status: "cancelled" as const };
  const { result, context } = calculate([earlier, earlier2, sameDay, pending, cancelled], [earlier, earlier2, sameDay]);
  for (const key of macroKeys) {
    expect(result.excludedCarryoverFromPlanning[key]).toBe(round(earlier.nutrition[key] + earlier2.nutrition[key]));
    expect(result.planningConsumed[key]).toBe(round(normal[key] + sameDay.nutrition[key] + pending.nutrition[key]));
  }
  expect(context.plannedNutrition).toEqual(pending.nutrition);
  const { day, diary } = fixture([earlier]);
  expect(() => carryoverContext([earlier, earlier], day, diary, "synthetic")).toThrow("supplied twice");
  expect(() => carryoverContext([pending, pending], day, diary, "synthetic")).toThrow("supplied twice");
});

test("repeated calculations never change state or compensate a registered carryover again", () => {
  const r = record(),
    { day, diary } = fixture([r]);
  const before = structuredClone({ r, day, diary, config });
  const call = () =>
    calculateGainer(
      { date, mode: "fitia_optimal", sweetener: "none" },
      config,
      day,
      carryoverContext([r], day, diary, "synthetic"),
    );
  const first = call();
  expect(call()).toEqual(first);
  expect(call()).toEqual(first);
  const receipt = { meal: "breakfast" as const, itemId: diary.meals[0]!.items[0]!.id };
  const consumed = { ...r, status: "consumed" as const, consumedEntry: receipt };
  const marked = calculateGainer(
    { date, mode: "fitia_optimal", sweetener: "none" },
    config,
    day,
    carryoverContext([consumed], day, diary, "synthetic"),
  );
  expect(marked.planningConsumed).toEqual(first.planningConsumed);
  expect(marked.baseMix).toEqual(first.baseMix);
  expect({ r, day, diary, config }).toEqual(before);
});

test("split projections distinguish the source-day batch from the actual night fraction", () => {
  const r = record(),
    { result } = calculate([r], [r], emptyMacros());
  if (!("nightPortion" in result)) throw new Error("Expected split");
  expect(result.nightPortion.nutrition.caloriesKcal).toBeLessThanOrEqual(config.maxNightCaloriesKcal);
  for (const key of macroKeys) {
    expect(result.effectiveProjection.consumedAfter[key]).toBe(result.fullBatch.practicalNutrition[key]);
    expect(result.fitiaProjection.consumedAfter[key]).toBe(
      round(r.nutrition[key] + result.nightPortion.nutrition[key]),
    );
    expect(round(result.nightMealLog[key] + result.morningCarryoverMealLog[key])).toBe(
      result.fullBatch.practicalNutrition[key],
    );
  }
  expect(result.suggestedMealLog).toEqual(result.nightMealLog);
});

test("calories mode retains the real Fitia gap while exposing the separate planning context", () => {
  const r = record(),
    { day, context } = calculate([r], [r]);
  for (const targetCaloriesKcal of [undefined, 500]) {
    const input = { date, mode: "calories" as const, sweetener: "none" as const, targetCaloriesKcal };
    const result = calculateGainer(input, config, day, context),
      previousBasis = calculateGainer(input, config, day);
    expect(result.baseMix).toEqual(previousBasis.baseMix);
    if (!("practicalNutrition" in result) || !("practicalNutrition" in previousBasis)) throw new Error(result.reason);
    expect(result.practicalNutrition).toEqual(previousBasis.practicalNutrition);
    expect(result.projection).toEqual(previousBasis.projection);
    expect(result.fitiaProjection).toEqual(result.practicalProjection);
    expect(result.planningConsumed).toEqual(normal);
    expect(result.configUsed.sweetenerInventory).toBe("honey_only");
  }
});

test("unknown registered macros remain unknown; attribution never fabricates complete nutrition", () => {
  const r = record(),
    { day, diary } = fixture([r]);
  day.consumed.proteinG = null;
  day.coverage.complete = false;
  const context = carryoverContext([r], day, diary, "synthetic");
  const result = calculateGainer({ date, mode: "fitia_optimal", sweetener: "none" }, config, day, context);
  expect(result.planningConsumed.proteinG).toBeNull();
  expect(result.status).toBe("needs_input");
  expect(result.effectiveProjection.consumedAfter.proteinG).toBeNull();
  expect(result.fitiaProjection.consumedAfter.proteinG).toBeNull();
});

test("verified whole-unit Fitia entries exclude their actual totals, not the unrounded saved recipe", () => {
  const r = record(),
    { day, diary } = fixture([r]);
  const item = diary.meals[0]!.items[0]!;
  const actual = emptyMacros();
  for (const key of macroKeys) {
    actual[key] = Math.round(r.nutrition[key]);
    item[key] = actual[key];
    day.consumed[key] = round(normal[key] + actual[key]);
  }
  day.remaining = difference(day.goals, day.consumed);
  const context = carryoverContext([r], day, diary, "synthetic");
  expect(actual).toEqual({ caloriesKcal: 445, proteinG: 13, carbsG: 75, fatG: 10 });
  expect(context.recordedNutrition).toEqual(actual);
  expect(context.excludedCarryoverFromPlanning).toEqual(actual);
  expect(context.planningConsumed).toEqual(normal);
  expect(context.items[0]).toMatchObject({ registeredNutrition: actual, verificationNutritionBasis: "whole_units" });
  const result = calculateGainer({ date, mode: "fitia_optimal", sweetener: "none" }, config, day, context);
  expect(result.baseMix).toEqual(calculate([], []).result.baseMix);
  expect(result.registeredConsumed).toEqual(day.consumed);
  const consumed = {
    ...r,
    status: "consumed" as const,
    consumedEntry: { meal: "breakfast" as const, itemId: item.id },
  };
  expect(carryoverContext([consumed], day, diary, "synthetic").planningConsumed).toEqual(normal);

  item.caloriesKcal = 446;
  expect(() => carryoverContext([r], day, diary, "synthetic")).toThrow("does not match");
  item.caloriesKcal = r.nutrition.caloriesKcal;
  expect(() => carryoverContext([r], day, diary, "synthetic")).toThrow("does not match");
  item.caloriesKcal = actual.caloriesKcal;
  item.eaten = false;
  expect(() => carryoverContext([r], day, diary, "synthetic")).toThrow("does not match");
  item.eaten = true;
  item.id = "unrelated-entry-with-the-same-macros";
  expect(carryoverContext([r], day, diary, "synthetic").excludedCarryoverFromPlanning).toEqual(emptyMacros());
});

import { expect, test } from "bun:test";
import { quickEntryIdentity } from "@fitia/core/diary";
import { calculateGainer } from "@fitia/core/gainer/calculator";
import {
  type CarryoverRecord,
  carryoverContext,
  type DiarySnapshot,
  planningDay,
  recordedCarryover,
} from "@fitia/core/gainer/carryover";
import { baseMixNutrition, defaultGainerConfig, gainerRecipe } from "@fitia/core/gainer/recipe";
import { divideNutrition, makeCarryoverPlan, nextDate, nightPercentage } from "@fitia/core/gainer/serving";
import { type Macros, macroKeys, round, summarizeDay } from "@fitia/core/nutrition";

const config = { ...defaultGainerConfig(), sweetenerInventory: "honey_only" as const };
function day(date = "2026-09-14", calories = 1200) {
  const ratio = calories / baseMixNutrition.caloriesKcal;
  return summarizeDay(
    {
      targetCalories: calories,
      targetProteins: baseMixNutrition.proteinG * ratio,
      targetCarbs: baseMixNutrition.carbsG * ratio,
      targetFats: baseMixNutrition.fatG * ratio,
      consumedCalories: 0,
      meals: {},
    },
    date,
    "stable-version",
  );
}
function result(calories: number) {
  return calculateGainer(
    { date: "2026-09-14", mode: "fitia_optimal", sweetener: "none" },
    config,
    day(undefined, calories),
  );
}
function split() {
  const r = result(1200);
  if (!("carryoverDraft" in r)) throw new Error("Expected split");
  return r;
}
function record(): CarryoverRecord {
  return { ...makeCarryoverPlan(split().carryoverDraft, config), status: "pending", version: "1", consumedEntry: null };
}
function diary(r: CarryoverRecord, logged: boolean): DiarySnapshot {
  return {
    date: r.targetDate,
    updateTime: "stable-version",
    consumedCaloriesKcal: logged ? r.nutrition.caloriesKcal : 0,
    limitations: [],
    meals: [
      {
        id: "breakfast",
        name: "breakfast",
        typeId: 0,
        items: logged
          ? [
              {
                id: quickEntryIdentity(
                  "test-account",
                  r.targetDate,
                  "breakfast",
                  r.morningCarryoverMealLog.idempotencyKey,
                ).id,
                sourceId: undefined,
                sourceSubcollection: undefined,
                name: r.morningCarryoverMealLog.name,
                type: "2",
                eaten: true,
                amount: undefined,
                ...r.nutrition,
              },
            ]
          : [],
      },
    ],
  };
}

test("optimal batches below 700 and between 700-750 remain single servings", () => {
  for (const [target, min, max] of [
    [700, 0, 700],
    [800, 700, 750],
  ]) {
    const r = result(target!);
    if (!("nutrition" in r)) throw new Error(r.reason);
    expect(r.servingStrategy).toBe("single_serving");
    expect(r.practicalNutrition.caloriesKcal).toBeGreaterThan(min!);
    expect(r.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(max!);
    expect(r.suggestedMealLog).toMatchObject(r.practicalNutrition);
  }
});

test("batch above 750 splits near preferred calories; dates and logging conserve the batch", () => {
  const r = split();
  expect(r.servingStrategy).toBe("split_next_morning");
  expect(r.nightPortion.nutrition.caloriesKcal).toBeGreaterThan(680);
  expect(r.nightPortion.nutrition.caloriesKcal).toBeLessThanOrEqual(750);
  expect(r.morningCarryover.targetDate).toBe("2026-09-15");
  expect(r.nightMealLog.date).toBe("2026-09-14");
  expect(r.morningCarryoverMealLog.date).toBe("2026-09-15");
  expect(r.nightPortion.fraction + r.morningCarryover.fraction).toBeCloseTo(1, 12);
  for (const key of macroKeys)
    expect(round(r.nightMealLog[key] + r.morningCarryoverMealLog[key])).toBe(r.practicalNutrition[key]);
  expect(r.suggestedMealLog).toEqual(r.nightMealLog);
  expect(r.exactMealLog).toBeNull();
  expect(r.nightPortion.creatineG + r.morningCarryover.creatineG).toBe(5);
  expect(r.fullBatch.ingredients.every((i) => Number.isInteger("practicalG" in i ? i.practicalG : i.practicalMl))).toBe(
    true,
  );
});

test("a larger batch can be roughly half, while a huge batch never violates night maximum", () => {
  for (const target of [1600, 3000]) {
    const r = result(target);
    if (!("nightPortion" in r)) throw new Error("Expected split");
    expect(r.nightPortion.nutrition.caloriesKcal).toBeLessThanOrEqual(750);
    if (target === 1600) expect(r.nightPortion.fraction).toBeCloseTo(0.5, 1);
    else expect(r.morningCarryover.fraction).toBeGreaterThan(0.5);
  }
});

test("night allowance can go above preferred only for a material green improvement", () => {
  const d = day();
  d.goals = { caloriesKcal: 2000, proteinG: 110, carbsG: 400, fatG: 100 };
  d.consumed = { caloriesKcal: 1000, proteinG: 130, carbsG: 250, fatG: 71 };
  const nutrition = { caloriesKcal: 1050, proteinG: 30, carbsG: 180, fatG: 28 };
  const percent = nightPercentage(nutrition, config, d);
  expect(percent).toBe(68);
  expect(divideNutrition(nutrition, percent).night.caloriesKcal).toBe(714);
});

test("the September 14 approximation splits a real practical honey batch without changing proportions", () => {
  const d = day();
  d.goals = { caloriesKcal: 2940, proteinG: 110, carbsG: 400, fatG: 98 };
  d.consumed = { caloriesKcal: 1983, proteinG: 148, carbsG: 185, fatG: 71 };
  d.remaining = { caloriesKcal: 957, proteinG: -38, carbsG: 215, fatG: 27 };
  const r = calculateGainer({ date: d.date, mode: "fitia_optimal", sweetener: "auto" }, config, d);
  if (!("carryoverDraft" in r)) throw new Error("Expected split");
  expect(r.practicalNutrition.caloriesKcal).toBeCloseTo(1034.13, 4);
  expect(r.nightPortion.nutrition.caloriesKcal).toBeCloseTo(703.2084, 4);
  expect(r.morningCarryover.nutrition.caloriesKcal).toBeCloseTo(330.9216, 4);
  expect(r.fullBatch.sweetener.practicalHoneyG).toBe(60);
  expect(r.nightProjection.consumedAfter.caloriesKcal).toBeLessThan(r.practicalProjection.consumedAfter.caloriesKcal!);
  expect(makeCarryoverPlan(r.carryoverDraft, config).id).toBe(r.carryoverId);
});

test("pending carryover is planned once; registered carryover stays in the real consumed totals once", () => {
  const r = record(),
    d = day(r.targetDate, 3000);
  const pending = carryoverContext([r], d, diary(r, false), "test-account");
  expect(pending.plannedNutrition).toEqual(r.nutrition);
  expect(planningDay(d, pending).consumed).toEqual(r.nutrition);
  expect(d.consumed.caloriesKcal).toBe(0);
  d.consumed = { ...r.nutrition };
  const registered = carryoverContext([r], d, diary(r, true), "test-account");
  expect(registered.plannedNutrition.caloriesKcal).toBe(0);
  expect(registered.recordedNutrition).toEqual(r.nutrition);
  expect(registered.normalConsumed.caloriesKcal).toBe(0);
  expect(registered.optimizationConsumed).toEqual(registered.normalConsumed);
  expect(registered.excludedCarryoverFromPlanning).toEqual(r.nutrition);
  expect(registered.items[0]!.status).toBe("pending");
  expect(registered.items[0]!.effectiveStatus).toBe("registered_in_fitia");
  const entry = recordedCarryover(r, diary(r, true), "test-account")!;
  expect(
    carryoverContext([{ ...r, status: "consumed", consumedEntry: entry }], d, diary(r, true), "test-account")
      .plannedNutrition.caloriesKcal,
  ).toBe(0);
});

test("cancelled carryover is neither planned nor subtracted from Fitia", () => {
  const r = { ...record(), status: "cancelled" as const },
    d = day("2026-09-15");
  const context = carryoverContext([r], d, null, "test-account");
  expect(context.plannedNutrition.caloriesKcal).toBe(0);
  expect(context.optimizationConsumed).toEqual(d.consumed);
});

test("missing or changed registered entry fails clearly; no double counting by guessed names", () => {
  const r = record(),
    logged = diary(r, true),
    entry = recordedCarryover(r, logged, "test-account")!;
  expect(() =>
    carryoverContext(
      [{ ...r, status: "consumed", consumedEntry: entry }],
      day(r.targetDate),
      diary(r, false),
      "test-account",
    ),
  ).toThrow("no longer");
  logged.meals[0]!.items[0]!.caloriesKcal = 1;
  expect(() => recordedCarryover(r, logged, "test-account")).toThrow("does not match");
  const manuallyLogged = diary(r, true);
  manuallyLogged.meals[0]!.items[0]!.id = "manual-receipt";
  expect(recordedCarryover(r, manuallyLogged, "test-account")).toBeNull();
  expect(recordedCarryover(r, manuallyLogged, "test-account", { meal: "breakfast", itemId: "manual-receipt" })).toEqual(
    { meal: "breakfast", itemId: "manual-receipt" },
  );
});

test("diary read races and duplicate entries cannot silently alter the planning budget", () => {
  const r = record(),
    snapshot = diary(r, true);
  snapshot.updateTime = "changed";
  expect(() => carryoverContext([r], day(r.targetDate), snapshot, "test-account")).toThrow("changed between");
  snapshot.updateTime = "stable-version";
  snapshot.meals.push({ ...snapshot.meals[0]!, id: "another-container" });
  expect(() => recordedCarryover(r, snapshot, "test-account")).toThrow("more than once");
});

test("next date handles month/year/leap boundaries and rejects out-of-contract dates", () => {
  expect(nextDate("2026-12-31")).toBe("2027-01-01");
  expect(nextDate("2028-02-28")).toBe("2028-02-29");
  expect(nextDate("2028-02-29")).toBe("2028-03-01");
  expect(() => nextDate("2100-12-31")).toThrow();
});

test("calories mode remains a single explicit-calorie calculation even above night limits", () => {
  const r = calculateGainer(
    { date: "2026-09-14", mode: "calories", sweetener: "none", targetCaloriesKcal: 1200 },
    config,
    day(),
  );
  expect(r).toMatchObject({ servingStrategy: "single_serving", nutrition: { caloriesKcal: 1200 } });
});

test("fractions preserve every rounded macro across varied practical batches", () => {
  for (let n = 1; n < 100; n++) {
    const batch: Macros = { caloriesKcal: 1054.123456, carbsG: 188.123456, proteinG: 30.987654, fatG: 29.123456 };
    const { night, morning } = divideNutrition(batch, n);
    for (const key of macroKeys) expect(round(night[key] + morning[key])).toBe(batch[key]);
  }
  expect(gainerRecipe.creatineG).toBe(5);
});

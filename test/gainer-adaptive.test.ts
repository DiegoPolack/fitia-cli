import { expect, test } from "bun:test";
import { adaptiveSearchPolicy } from "@fitia/core/gainer/adaptive";
import { calculateGainer } from "@fitia/core/gainer/calculator";
import { carryoverContext, planningDay } from "@fitia/core/gainer/carryover";
import { defaultGainerConfig, type GainerConfig, gainerRecipe, type SweetenerMode } from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { difference, emptyMacros, type Macros, macroKeys, round, summarizeDay } from "@fitia/core/nutrition";
import { carryoverDraftSchema } from "../apps/mcp/src/gainer-carryover.ts";
import { mergeGainerConfig, parseGainerConfig } from "../apps/mcp/src/gainer-config.ts";

const date = "2026-09-17";
const goals = { caloriesKcal: 3000, proteinG: 110, carbsG: 400, fatG: 90 };
const imbalanced = { caloriesKcal: 2400, proteinG: 150, carbsG: 200, fatG: 120 };
function day(consumed: Macros) {
  const summary = summarizeDay(
    {
      targetCalories: goals.caloriesKcal,
      targetProteins: goals.proteinG,
      targetCarbs: goals.carbsG,
      targetFats: goals.fatG,
      consumedCalories: 0,
      meals: {},
    },
    date,
    "synthetic-snapshot",
  );
  summary.consumed = consumed;
  summary.remaining = difference(summary.goals, consumed);
  return summary;
}
function calculate(consumed = imbalanced, sweetener: SweetenerMode = "none", config = defaultGainerConfig()) {
  return calculateGainer({ date, mode: "fitia_adaptive", sweetener }, config, day(consumed));
}
function drink(result: ReturnType<typeof calculate>) {
  if (!("practicalNutrition" in result) || result.optimization?.mode !== "fitia_adaptive")
    throw new Error(result.reason);
  return { ...result, optimization: result.optimization };
}

test("adaptive improves a carb deficit with high protein/fat under the same comparative score", () => {
  const result = drink(calculate());
  const fixed = calculateGainer(
    { date, mode: "fitia_optimal", sweetener: "none" },
    defaultGainerConfig(),
    day(imbalanced),
  );
  if (!("practicalNutrition" in fixed)) throw new Error(fixed.reason);
  const comparison = result.optimization.adaptive.comparison;
  expect(comparison.fixedProportions.nutrition).toEqual(fixed.practicalNutrition);
  expect(comparison.adaptiveNutritionScore).toBeLessThan(comparison.fixedProportions.nutritionScore);
  expect(result.optimization.before).toEqual({ caloriesKcal: "low", proteinG: "high", carbsG: "low", fatG: "high" });
  const amounts = result.optimization.amounts!;
  expect(amounts.nestum / 20).toBeGreaterThan(amounts.anchor / 50);
  expect(result.practicalNutrition.fatG).toBeLessThan(fixed.practicalNutrition.fatG);
  expect(result.optimization.score.after).toBeLessThan(result.optimization.score.before);
});

test.each([
  ["protein low / carbs high", { caloriesKcal: 2700, proteinG: 60, carbsG: 470, fatG: 82 }, "proteinG"],
  ["fat low", { caloriesKcal: 2700, proteinG: 105, carbsG: 370, fatG: 40 }, "fatG"],
  ["all low", { caloriesKcal: 1600, proteinG: 50, carbsG: 150, fatG: 40 }, "caloriesKcal"],
] as const)("adaptive uses practical macros for %s", (_label, consumed, metric) => {
  const result = drink(calculate(consumed));
  expect(result.optimization.improvedMetrics).toContain(metric);
  expect(result.optimization.score.after).toBeLessThan(result.optimization.score.before);
  expect(result.effectiveProjection.consumedAfter.caloriesKcal).toBeLessThanOrEqual(3300);
});

test.each(["none", "honey_only", "both", "stevia_only"] as const)(
  "sweetener %s remains fixed; nutrition, integer quantities, cost, water and logging agree",
  (sweetener) => {
    const result = drink(calculate(imbalanced, sweetener));
    const expected = emptyMacros();
    let dry = gainerRecipe.creatineG,
      cost = 0;
    for (const item of result.ingredients) {
      const ingredient = gainerRecipe.ingredients.find((i) => i.id === item.id)!;
      const amount = "practicalG" in item ? item.practicalG : item.practicalMl;
      expect(Number.isInteger(amount)).toBe(true);
      expect("exactG" in item ? item.exactG : item.exactMl).toBe(amount);
      const bounds = result.configUsed.adaptive.bounds[ingredient.id];
      expect(amount / ingredient.amount).toBeGreaterThanOrEqual(bounds.minFactor - 1e-9);
      expect(amount / ingredient.amount).toBeLessThanOrEqual(bounds.maxFactor + 1e-9);
      if (ingredient.unit === "g") dry += amount;
      cost += (amount * ingredient.price.pen) / ingredient.price.packageAmount;
      for (const key of macroKeys) expected[key] += ((ingredient.nutrition?.[key] ?? 0) * amount) / ingredient.amount;
    }
    for (const key of macroKeys) {
      expected[key] += (result.sweetener.practicalHoneyG * result.configUsed.honeyProfile.per100G[key]) / 100;
      expect(result.practicalNutrition[key]).toBe(round(expected[key]));
      expect(result.effectiveProjection.consumedAfter[key]).toBe(
        round(imbalanced[key] + result.practicalNutrition[key]),
      );
    }
    expect(result.cost.practicalPen).toBe(round(cost));
    expect(result.water.practicalMl).toBe(Math.round((dry * result.configUsed.adaptive.waterMlPerDryGram) / 10) * 10);
    expect(result.creatineG).toBe(5);
    expect(result.sweetener).toMatchObject(gainerRecipe.sweeteners[sweetener]);
    expect(result.sweetener.practicalHoneyG).toBe(gainerRecipe.sweeteners[sweetener].honeyTablespoons * 20);
    expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(900);
    const logged = "nightPortion" in result ? result.nightPortion.nutrition : result.practicalNutrition;
    for (const key of macroKeys) expect(result.suggestedMealLog[key]).toBe(logged[key]);
  },
);

test("all green, near calorie ceiling, unknown inventory and excessive honey return no drink", () => {
  expect(calculate({ caloriesKcal: 3000, proteinG: 110, carbsG: 400, fatG: 90 })).toMatchObject({
    suggestedMealLog: null,
    optimization: { outcome: "not_needed" },
  });
  expect(calculate({ ...imbalanced, caloriesKcal: 3295 })).toMatchObject({
    suggestedMealLog: null,
    baseMix: { scaleFactor: 0 },
  });
  expect(calculate(imbalanced, "auto")).toMatchObject({ status: "needs_input" });
  expect(calculate({ ...imbalanced, caloriesKcal: 3200 }, "honey_only")).toMatchObject({
    status: "sweetener_exceeds_target",
    suggestedMealLog: null,
  });
});

test("configuration bounds and global limits are enforced after rounding, with compatible deep defaults", () => {
  const config = parseGainerConfig({
    sweetenerInventory: "honey_only",
    adaptive: { bounds: { anchor: { minFactor: 0, maxFactor: 0 } }, maxBatchCaloriesKcal: 400, maxDrySolidsG: 105 },
  });
  expect(config.defaultMode).toBe("fitia_optimal");
  const result = drink(calculate(imbalanced, "none", config));
  expect(result.optimization.amounts!.anchor).toBe(0);
  expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(400);
  expect(
    result.ingredients.reduce((sum, i) => sum + ("practicalG" in i ? i.practicalG : 0), result.creatineG),
  ).toBeLessThanOrEqual(105);
  const merged = parseGainerConfig(mergeGainerConfig(config, { adaptive: { metricWeights: { carbsG: 2 } } }));
  expect(merged.adaptive.bounds.anchor.maxFactor).toBe(0);
  expect(merged.adaptive.metricWeights).toEqual({ caloriesKcal: 4, proteinG: 1, carbsG: 2, fatG: 1 });
  for (const adaptive of [
    { bounds: { cocoa: { minFactor: 2, maxFactor: 1 } } },
    { bounds: { cinnamon: { minFactor: 0.2, maxFactor: 0.3 } } },
    { maxDrySolidsG: 10 },
    { waterMlPerDryGram: 0 },
    { metricWeights: { carbsG: Number.NaN } },
    { bounds: { unknown_ingredient: { minFactor: 0, maxFactor: 1 } } },
  ])
    expect(() => parseGainerConfig({ adaptive })).toThrow();
});

test("deterministic bounded work, no input mutations, default fixed mode unchanged by adaptive settings", () => {
  const config = defaultGainerConfig(),
    summary = day(imbalanced);
  const original = structuredClone({ config, summary });
  const first = calculateGainer({ date, mode: "fitia_adaptive", sweetener: "none" }, config, summary);
  expect(calculateGainer({ date, mode: "fitia_adaptive", sweetener: "none" }, config, summary)).toEqual(first);
  expect({ config, summary }).toEqual(original);
  expect(first.optimization!.evaluatedCandidates).toBeLessThanOrEqual(adaptiveSearchPolicy.maxCandidates);
  const fixed = calculateGainer({ date, sweetener: "none" }, config, summary);
  const changed: GainerConfig = {
    ...config,
    adaptive: { ...config.adaptive, deviationWeight: 1, waterMlPerDryGram: 9 },
  };
  const stillFixed = calculateGainer({ date, sweetener: "none" }, changed, summary);
  expect(stillFixed.mode).toBe("fitia_optimal");
  expect(stillFixed.optimization).toEqual(fixed.optimization);
  if (!("practicalNutrition" in fixed) || !("practicalNutrition" in stillFixed))
    throw new Error("Expected fixed drink");
  expect(stillFixed.ingredients).toEqual(fixed.ingredients);
  expect(stillFixed.water).toEqual(fixed.water);
});

test("zero ingredient minimums still allow a beneficial recipe", () => {
  const config = defaultGainerConfig();
  for (const bounds of Object.values(config.adaptive.bounds)) bounds.minFactor = 0;
  const result = drink(calculate(imbalanced, "none", config));
  expect(result.practicalNutrition.caloriesKcal).toBeGreaterThan(0);
  expect(result.optimization.score.after).toBeLessThan(result.optimization.score.before);
});

test("adaptive split freezes individual amounts and preserves nutrition, water, IDs and night cap", () => {
  const result = drink(calculate({ caloriesKcal: 1600, proteinG: 50, carbsG: 150, fatG: 40 }));
  if (!("carryoverDraft" in result)) throw new Error("Expected split");
  expect(result.nightPortion.nutrition.caloriesKcal).toBeLessThanOrEqual(750);
  expect(result.carryoverDraft.adaptiveAmounts).toEqual(result.optimization.amounts);
  const parsed = carryoverDraftSchema.parse({ ...result.carryoverDraft, configVersion: "1" });
  const restored = makeCarryoverPlan(parsed, parseGainerConfig(JSON.parse(JSON.stringify(result.configUsed))));
  expect(restored.id).toBe(result.carryoverId);
  expect(restored.fullBatch.practicalNutrition).toEqual(result.practicalNutrition);
  expect(restored.fullBatch.water.practicalMl).toBe(result.water.practicalMl);
  expect(restored.fullBatch.ingredients).toEqual(
    result.ingredients.map(({ id, name, ...amount }) => ({
      id,
      name,
      ...("practicalG" in amount ? { practicalG: amount.practicalG } : { practicalMl: amount.practicalMl }),
    })),
  );
  for (const key of macroKeys)
    expect(round(restored.nightPortion.nutrition[key] + restored.nutrition[key])).toBe(result.practicalNutrition[key]);
  expect(result.exactMealLog).toBeNull();
  expect(() =>
    makeCarryoverPlan({ ...parsed, adaptiveAmounts: { ...parsed.adaptiveAmounts!, anchor: 1001 } }, result.configUsed),
  ).toThrow();
  expect(() => makeCarryoverPlan({ ...parsed, scaleFactor: parsed.scaleFactor + 1 }, result.configUsed)).toThrow();
});

test("active pending carryover reserves once and adaptive uses the same planning basis", () => {
  const config = defaultGainerConfig();
  const record = {
    ...makeCarryoverPlan(
      { sourceDate: "2026-09-16", recipeId: gainerRecipe.id, scaleFactor: 1.7, sweetener: "none", nightPercent: 70 },
      config,
    ),
    status: "pending" as const,
    version: "1",
    consumedEntry: null,
  };
  const summary = day(imbalanced);
  const diary = {
    date,
    updateTime: summary.updateTime,
    consumedCaloriesKcal: imbalanced.caloriesKcal,
    limitations: [],
    meals: [],
  };
  const context = carryoverContext([record], summary, diary, "synthetic");
  const actual = calculateGainer({ date, mode: "fitia_adaptive", sweetener: "none" }, config, summary, context);
  const expected = calculateGainer(
    { date, mode: "fitia_adaptive", sweetener: "none" },
    config,
    planningDay(summary, context),
  );
  expect(actual.optimization).toEqual(expected.optimization);
  expect(actual.planningConsumed.caloriesKcal).toBe(round(imbalanced.caloriesKcal + record.nutrition.caloriesKcal));
  expect(actual.registeredConsumed).toEqual(imbalanced);
  expect(actual.excludedCarryoverFromPlanning).toEqual(emptyMacros());
});

import { expect, test } from "bun:test";
import { adaptiveSearchPolicy } from "@fitia/core/gainer/adaptive";
import {
  deriveProportionalBatch,
  honeyCandidates,
  mainAmounts,
  proportionalBounds,
  proportionalDeviation,
  proportionalHoney,
  proportionalSettings,
} from "@fitia/core/gainer/adaptive-proportional";
import { calculateGainer, type GainerInput } from "@fitia/core/gainer/calculator";
import { carryoverContext, planningDay } from "@fitia/core/gainer/carryover";
import { greenRanges, scoreGainer } from "@fitia/core/gainer/optimization";
import { amountsNutrition, drySolidsG } from "@fitia/core/gainer/portion";
import { resolveRecipe } from "@fitia/core/gainer/profiles";
import {
  adaptiveMainIds,
  baseMixNutrition,
  defaultGainerConfig,
  gainerRecipe,
  type MainAmounts,
} from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { type DaySummary, difference, emptyMacros, macroKeys, round } from "@fitia/core/nutrition";
import { carryoverDraftSchema } from "../apps/mcp/src/gainer-carryover.ts";
import { mergeGainerConfig, parseGainerConfig } from "../apps/mcp/src/gainer-config.ts";
import fixture from "./fixtures/adaptive-problem.json";

const config = defaultGainerConfig(),
  recipe = resolveRecipe(config),
  base: MainAmounts = { quaker_oats: 50, anchor: 50, nestum: 20, seven_cereals: 10 };
const day = fixture.day as DaySummary;
function calculate(
  settings = defaultGainerConfig(),
  sweetener: GainerInput["sweetener"] = "honey_only",
  summary = day,
) {
  return calculateGainer({ ...fixture.input, mode: "fitia_adaptive", sweetener }, settings, summary);
}
function drink(result = calculate()) {
  if (
    !("ingredients" in result) ||
    result.optimization?.mode !== "fitia_adaptive" ||
    !("preparation" in result.optimization) ||
    !result.optimization.preparation
  )
    throw new Error(result.reason);
  return { ...result, optimization: result.optimization };
}

test("dynamic whole bounds center on the daily 56/56/22/11 baseline, not absolute recipe amounts", () => {
  const baseline = { quaker_oats: 56, anchor: 56, nestum: 22, seven_cereals: 11 };
  expect(proportionalBounds(baseline, config.adaptive, recipe).map((b) => [b.min, b.max])).toEqual([
    [40, 72],
    [40, 72],
    [16, 28],
    [8, 14],
  ]);
  const larger = { quaker_oats: 112, anchor: 112, nestum: 44, seven_cereals: 22 };
  expect(proportionalBounds(larger, config.adaptive, recipe)[0]).toMatchObject({ baseline: 112, min: 79, max: 145 });
});

test("derived ingredients and water reproduce base quantities, then track a 20 percent main increase", () => {
  const original = deriveProportionalBatch(base, config.adaptive, recipe);
  expect(original.amounts).toEqual({ ...base, maca: 5, cocoa: 5, cinnamon: 1, vanilla: 3 });
  expect(original.waterMl).toBeCloseTo(gainerRecipe.waterMl, 10);
  const larger = deriveProportionalBatch(
    { quaker_oats: 60, anchor: 60, nestum: 24, seven_cereals: 12 },
    config.adaptive,
    recipe,
  );
  expect(larger.mainDryScale).toBe(1.2);
  expect(larger.amounts).toMatchObject({ maca: 6, cocoa: 6, cinnamon: 1, vanilla: 4 });
  expect(larger.waterMl).toBeCloseTo(original.waterMl * 1.2, 10);
  // Anchor is not privileged: equal main mass gives equal derived amounts/water.
  expect(deriveProportionalBatch({ ...base, anchor: 30, quaker_oats: 70 }, config.adaptive, recipe).waterMl).toBe(
    original.waterMl,
  );
});

test("honey target has only the three neighboring integer doses; other modes remain fixed", () => {
  expect(honeyCandidates("honey_only", 1)).toEqual({ targetTablespoons: 3, candidateTablespoons: [2, 3, 4] });
  expect(honeyCandidates("honey_only", 0)).toEqual({ targetTablespoons: 0, candidateTablespoons: [0, 1] });
  for (const mode of ["both", "stevia_only", "none"] as const)
    expect(honeyCandidates(mode, 5).candidateTablespoons).toEqual([gainerRecipe.sweeteners[mode].honeyTablespoons]);
  const custom = { ...config, honeyGramsPerTablespoon: 17.3 };
  expect(proportionalHoney(3, custom).honeyG).toBeCloseTo(51.9, 10);
  expect(proportionalHoney(3, custom).practicalHoneyG).toBe(52);
});

test("problem fixture reproduces old recipe and rejects its combination under the new dynamic bounds", () => {
  const old = calculate(parseGainerConfig({ adaptive: { strategy: "legacy_v1" } }));
  if (!("ingredients" in old) || old.optimization?.mode !== "fitia_adaptive") throw new Error(old.reason);
  expect(old.optimization.amounts).toEqual(fixture.legacy.amounts);
  expect(old.practicalNutrition).toEqual(fixture.legacy.nutrition);
  const result = drink();
  const bounds = result.optimization.adaptive.bounds;
  expect(bounds.some((b) => fixture.legacy.amounts[b.id] < b.min || fixture.legacy.amounts[b.id] > b.max)).toBe(true);
  const reported = { quaker_oats: 10, anchor: 84, nestum: 5, seven_cereals: 4 };
  expect(bounds.some((b) => reported[b.id] < b.min || reported[b.id] > b.max)).toBe(true);
  for (const bound of bounds) {
    const value = result.optimization.amounts![bound.id]!;
    expect(value).toBeGreaterThanOrEqual(bound.min);
    expect(value).toBeLessThanOrEqual(bound.max);
  }
  expect(result.optimization.adaptive.ingredientAdjustments.map((i) => i.id)).toEqual([...adaptiveMainIds]);
});

test.each(["none", "honey_only", "both", "stevia_only"] as const)(
  "%s uses practical nutrition, fixed creatine, bounded honey, derived water and coherent logs",
  (sweetener) => {
    const settings = parseGainerConfig({ honeyGramsPerTablespoon: 17.3 });
    const result = drink(calculate(settings, sweetener));
    const opt = result.optimization,
      amounts = opt.amounts!,
      derived = deriveProportionalBatch(mainAmounts(amounts), settings.adaptive, resolveRecipe(settings));
    expect(result.creatineG).toBe(gainerRecipe.creatineG);
    expect(amounts).toEqual(derived.amounts);
    for (const i of result.ingredients) {
      const q = "practicalG" in i ? i.practicalG : i.practicalMl;
      expect(Number.isInteger(q)).toBe(true);
      expect("exactG" in i ? i.exactG : i.exactMl).toBe(q);
    }
    expect(result.water.exactMl).toBe(derived.waterMl);
    expect(result.water.practicalMl).toBe(Math.round(derived.waterMl / 10) * 10);
    expect(opt.adaptive.honey!.candidateTablespoons).toContain(result.sweetener.honeyTablespoons);
    const honey = proportionalHoney(result.sweetener.honeyTablespoons, settings);
    expect(result.practicalNutrition).toEqual(amountsNutrition(amounts, honey.practical, recipe));
    expect(result.nutrition).toEqual(amountsNutrition(amounts, honey.exact, recipe));
    expect(drySolidsG(amounts, recipe)).toBeLessThanOrEqual(settings.adaptive.maxDrySolidsG);
    expect(Math.max(result.practicalNutrition.caloriesKcal, result.nutrition.caloriesKcal)).toBeLessThanOrEqual(
      opt.maxAdditionalCaloriesKcal + 1e-6,
    );
    const logged = "nightPortion" in result ? result.nightPortion.nutrition : result.practicalNutrition;
    for (const key of macroKeys) expect(result.suggestedMealLog[key]).toBe(logged[key]);
    expect(result.ingredients.some((i) => i.id === "maltodex")).toBe(false);
  },
);

test("comparison uses one Adaptive scoring function and deviation only measures four main decisions", () => {
  const result = drink(),
    opt = result.optimization;
  const fixed = calculateGainer({ ...fixture.input, mode: "fitia_optimal" }, config, day);
  if (!("practicalNutrition" in fixed)) throw new Error(fixed.reason);
  expect(opt.adaptive.comparison.fixedProportions.nutrition).toEqual(fixed.practicalNutrition);
  for (const [nutrition, score] of [
    [fixed.practicalNutrition, opt.adaptive.comparison.fixedProportions.nutritionScore],
    [result.practicalNutrition, opt.adaptive.comparison.adaptiveNutritionScore],
  ] as const) {
    expect(score).toBe(
      scoreGainer(
        day.consumed as typeof nutrition,
        greenRanges(day.goals)!,
        nutrition,
        config.adaptive.metricWeights,
        config.adaptive.alreadyHighMultipliers,
      ).total,
    );
  }
  expect(opt.adaptive.deviationPenalty).toBe(
    proportionalDeviation(mainAmounts(opt.amounts!), opt.adaptive.baseline, config.adaptive),
  );
  expect(opt.adaptive.comparison.fixedProportions.deviationPenalty).toBe(0);
  expect(opt.score.after).toBe(opt.score.nutritionAfter + opt.adaptive.deviationPenalty);
});

test("old config migrates without losing custom bounds; new deviation patches merge and hydration converts units", () => {
  const old = parseGainerConfig({
    adaptive: { bounds: { anchor: { minFactor: 0, maxFactor: 1.5 } }, waterMlPerDryGram: 5 },
  });
  expect(old.adaptive.strategy).toBe("proportional_v2");
  expect(old.adaptive.bounds.anchor.maxFactor).toBe(1.5);
  expect(old.adaptive.ingredientDeviation).toEqual({ quaker_oats: 0.3, anchor: 0.3, nestum: 0.3, seven_cereals: 0.3 });
  expect(proportionalSettings(old.adaptive, resolveRecipe(old)).waterMlPerMainDryGram).toBeCloseTo((5 * 146) / 130, 10);
  const patched = parseGainerConfig(
    mergeGainerConfig(old, { adaptive: { ingredientDeviation: { anchor: 0.2 }, waterMlPerMainDryGram: 4 } }),
  );
  expect(patched.adaptive.ingredientDeviation).toEqual({
    quaker_oats: 0.3,
    anchor: 0.2,
    nestum: 0.3,
    seven_cereals: 0.3,
  });
  expect(deriveProportionalBatch(base, patched.adaptive, resolveRecipe(patched)).waterMl).toBe(520);
  expect(
    parseGainerConfig(mergeGainerConfig(patched, { adaptive: { strategy: "legacy_v1" } })).adaptive.bounds.anchor
      .maxFactor,
  ).toBe(1.5);
  for (const ingredientDeviation of [{ anchor: -0.1 }, { anchor: 1.1 }, { maca: 0.3 }])
    expect(() => parseGainerConfig({ adaptive: { ingredientDeviation } })).toThrow();
});

test("no drink and physical constraints never trigger an unbounded or legacy recipe fallback", () => {
  const green = { ...day, consumed: { ...day.goals }, remaining: emptyMacros() };
  expect(calculate(config, "none", green)).toMatchObject({
    suggestedMealLog: null,
    optimization: { outcome: "not_needed" },
  });
  expect(calculate(config, "auto")).toMatchObject({ status: "needs_input" });
  for (const adaptive of [{ maxDrySolidsG: 40 }, { maxBatchCaloriesKcal: 300 }]) {
    const settings = parseGainerConfig({ adaptive }),
      result = calculate(settings);
    if ("practicalNutrition" in result) {
      expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(settings.adaptive.maxBatchCaloriesKcal);
      expect(
        drySolidsG(result.optimization!.mode === "fitia_adaptive" ? result.optimization!.amounts! : {}, recipe),
      ).toBeLessThanOrEqual(settings.adaptive.maxDrySolidsG);
    } else expect(result.suggestedMealLog).toBeNull();
  }
  const tiny = {
    ...day,
    consumed: { ...day.consumed, caloriesKcal: 3250 },
    remaining: difference(day.goals, { ...day.consumed, caloriesKcal: 3250 }),
  };
  const result = calculate(config, "honey_only", tiny);
  expect(result.status).not.toBe("sweetener_exceeds_target");
  if ("nutrition" in result) expect(result.nutrition.caloriesKcal).toBeLessThanOrEqual(50 + 1e-6);
});

test("new split freezes preparation, actual honey, derived water and concrete amounts", () => {
  const settings = parseGainerConfig({ maxNightCaloriesKcal: 350, preferredNightCaloriesKcal: 300 });
  const result = drink(calculate(settings));
  if (!("carryoverDraft" in result)) throw new Error("Expected synthetic split");
  expect(result.carryoverDraft.adaptivePreparation!.version).toBe("proportional_v2");
  const parsed = carryoverDraftSchema.parse({ ...result.carryoverDraft, configVersion: "1" });
  const restored = makeCarryoverPlan(parsed, parseGainerConfig(JSON.parse(JSON.stringify(settings))));
  expect(restored.id).toBe(result.carryoverId);
  expect(restored.fullBatch.practicalNutrition).toEqual(result.practicalNutrition);
  expect(restored.fullBatch.water).toMatchObject({ practicalMl: result.water.practicalMl });
  expect(restored.fullBatch.sweetener.honeyTablespoons).toBe(result.sweetener.honeyTablespoons);
  for (const key of macroKeys)
    expect(round(restored.nightPortion.nutrition[key] + restored.nutrition[key])).toBe(result.practicalNutrition[key]);
  expect(result.suggestedMealLog).toEqual(result.nightMealLog);
  expect(() =>
    makeCarryoverPlan(
      { ...parsed, adaptivePreparation: { ...parsed.adaptivePreparation!, honeyTablespoons: 100 } },
      settings,
    ),
  ).toThrow();
  expect(() =>
    makeCarryoverPlan({ ...parsed, adaptiveAmounts: { ...parsed.adaptiveAmounts!, maca: 999 } }, settings),
  ).toThrow();
  expect(() =>
    makeCarryoverPlan({ ...parsed, adaptiveAmounts: { ...parsed.adaptiveAmounts!, maltodex: 0 } }, settings),
  ).toThrow();
});

test("old concrete adaptive carryover keeps its original water, honey, nutrition and identifier", () => {
  const amounts = {
    quaker_oats: 10,
    anchor: 84,
    nestum: 5,
    seven_cereals: 4,
    maca: 2,
    cocoa: 2,
    cinnamon: 1,
    vanilla: 2,
  };
  const legacy = parseGainerConfig({
    adaptive: { strategy: "legacy_v1" },
    maxNightCaloriesKcal: 350,
    preferredNightCaloriesKcal: 300,
  });
  const draft = {
    sourceDate: day.date,
    recipeId: gainerRecipe.id,
    scaleFactor: amountsNutrition(amounts, emptyMacros()).caloriesKcal / baseMixNutrition.caloriesKcal,
    sweetener: "honey_only" as const,
    nightPercent: 50,
    adaptiveAmounts: amounts,
  };
  const original = makeCarryoverPlan(draft, legacy);
  const { strategy: _strategy, ingredientDeviation: _deviation, ...oldAdaptive } = legacy.adaptive;
  const migrated = parseGainerConfig({ ...legacy, adaptive: oldAdaptive });
  expect(migrated.adaptive.strategy).toBe("proportional_v2");
  const restored = makeCarryoverPlan(draft, migrated);
  expect(restored.id).toBe(original.id);
  expect(restored.fullBatch).toEqual(original.fullBatch);
  expect(restored.fullBatch.water.practicalMl).toBe(460);
  expect(restored.fullBatch.sweetener.practicalHoneyG).toBe(60);
  expect(restored.definition.draft.adaptiveAmounts).toEqual(amounts);
});

test("determinism, bounded evaluations, planning attribution, and unchanged fixed mode", () => {
  const settings = defaultGainerConfig(),
    untouched = structuredClone(settings),
    first = calculate(settings);
  expect(calculate(settings)).toEqual(first);
  expect(settings).toEqual(untouched);
  expect(first.optimization!.evaluatedCandidates).toBeLessThanOrEqual(adaptiveSearchPolicy.maxCandidates);
  const changed = parseGainerConfig({ adaptive: { ingredientDeviation: { anchor: 0.1 }, waterMlPerMainDryGram: 10 } });
  const fixed = (c: typeof config) => calculateGainer({ ...fixture.input, mode: "fitia_optimal" }, c, day);
  const { configUsed: _a, ...a } = fixed(settings),
    { configUsed: _b, ...b } = fixed(changed);
  expect(a).toEqual(b);
  const source = makeCarryoverPlan(
    { sourceDate: "2026-09-22", recipeId: gainerRecipe.id, scaleFactor: 1.7, sweetener: "none", nightPercent: 70 },
    settings,
  );
  const record = { ...source, status: "pending" as const, version: "1", consumedEntry: null };
  const diary = {
    date: day.date,
    updateTime: day.updateTime,
    consumedCaloriesKcal: day.consumed.caloriesKcal,
    limitations: [],
    meals: [],
  };
  const context = carryoverContext([record], day, diary, "synthetic");
  const actual = calculateGainer({ ...fixture.input, mode: "fitia_adaptive" }, settings, day, context);
  const expected = calculate(settings, "honey_only", planningDay(day, context));
  expect(actual.optimization).toEqual(expected.optimization);
});

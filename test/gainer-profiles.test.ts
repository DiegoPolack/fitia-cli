import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { minimumAdaptiveAmounts, validAdaptiveAmounts } from "@fitia/core/gainer/adaptive";
import { calculateGainer, type GainerInput } from "@fitia/core/gainer/calculator";
import { amountsNutrition, drySolidsG, scaledAmounts, waterForAmounts } from "@fitia/core/gainer/portion";
import { futureRecipeProfile, maltodexCandidate, resolveRecipe } from "@fitia/core/gainer/profiles";
import { defaultGainerConfig } from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import type { DaySummary } from "@fitia/core/nutrition";
import { carryoverDraftSchema } from "../apps/mcp/src/gainer-carryover.ts";
import { mergeGainerConfig, parseGainerConfig } from "../apps/mcp/src/gainer-config.ts";
import baseline from "./fixtures/gainer-legacy-v1.json";

// Only new inspection/configuration fields are excluded; every historical result
// field, including IDs, candidate counts, complete scoring and logs, is compared.
const additive = new Set([
  "activeProfile",
  "recipeProfiles",
  "recipeProfile",
  "scoringComponents",
  "strategy",
  "ingredientDeviation",
  "waterMlPerMainDryGram",
]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !additive.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
function historicalHash(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
for (const [index, fixture] of baseline.fixtures.entries())
  test(`frozen legacy ${index}: ${fixture.input.mode}/${fixture.input.sweetener}/${fixture.input.date}`, () => {
    const config = parseGainerConfig(fixture.configPatch);
    // The frozen fallback remains byte-for-byte equivalent; current Adaptive is
    // now an explicitly versioned algorithm independent of the recipe profile.
    if (fixture.input.mode === "fitia_adaptive") config.adaptive.strategy = "legacy_v1";
    const result = calculateGainer(fixture.input as GainerInput, config, fixture.day as DaySummary);
    expect(config.activeProfile).toBe("legacy_v1");
    expect(config.recipeProfiles.legacy_v1.ingredients.maltodex!.enabled).toBe(false);
    expect(historicalHash(result)).toBe(fixture.sha256);
  });

const fixture = baseline.fixtures[0]!;
const summary = fixture.day as DaySummary;
function futureBaseConfig() {
  return parseGainerConfig({
    activeProfile: "future_v2",
    recipeProfiles: {
      future_v2: {
        ingredients: {
          anchor: { amountMode: "base", baseAmount: 30, adaptiveBounds: { minFactor: 0, maxFactor: 2 } },
          quaker_oats: { baseAmount: 70 },
          nestum: { adaptiveBounds: { minFactor: 0.25, maxFactor: 2.5 } },
        },
      },
    },
  });
}
function calculate(config = defaultGainerConfig(), mode: GainerInput["mode"] = "fitia_adaptive") {
  return calculateGainer(
    { date: summary.date, mode, sweetener: "none", ...(mode === "calories" ? { targetCaloriesKcal: 500 } : {}) },
    config,
    summary,
  );
}
function operational(result: ReturnType<typeof calculate>) {
  const { configUsed: _config, recipeProfile: _profile, ...rest } = result;
  return JSON.parse(JSON.stringify(rest));
}

test("old JSON normalizes to immutable explicit legacy, with no future profile active or created", () => {
  const config = parseGainerConfig({ sweetenerInventory: "honey_only" });
  expect(config).toEqual({ ...defaultGainerConfig(), sweetenerInventory: "honey_only" });
  expect(config.recipeProfiles.future_v2).toBeUndefined();
  expect(() => parseGainerConfig({ activeProfile: "future_v2" })).toThrow("requires a configured profile");
  const altered = structuredClone(config);
  altered.recipeProfiles.legacy_v1.ingredients.quaker_oats!.baseAmount = 70;
  expect(() => parseGainerConfig(altered)).toThrow("legacy_v1 is frozen");
  expect(() => calculate(altered)).toThrow("legacy_v1 is frozen");
});

test("inactive incomplete future profile does not affect any legacy operational field", () => {
  const config = parseGainerConfig({ recipeProfiles: { future_v2: {} } });
  expect(config.recipeProfiles.future_v2).toEqual(futureRecipeProfile());
  expect(config.recipeProfiles.future_v2!.ingredients.nestum!.adaptiveBounds).toBeNull();
  expect(config.recipeProfiles.legacy_v1.ingredients.nestum!.adaptiveBounds!.maxFactor).toBe(6);
  expect(config.recipeProfiles.future_v2!.ingredients.anchor!.gramsPer100MlWater).toBeNull();
  for (const mode of ["calories", "fitia_optimal", "fitia_adaptive"] as const)
    expect(operational(calculate(config, mode))).toEqual(operational(calculate(defaultGainerConfig(), mode)));
  expect(() => parseGainerConfig({ ...config, activeProfile: "future_v2" })).toThrow("water_ratio");
});

test("product-specific disabled Maltodex keeps unknown protein and observed price/label", () => {
  const malt = maltodexCandidate();
  expect(malt.enabled).toBe(false);
  expect(malt.flavor).toBe("unflavored");
  expect(malt.nutrition).toEqual({
    basisAmount: 40,
    macros: { caloriesKcal: 152, proteinG: null, carbsG: 38, fatG: 0 },
    fiberG: 0,
    source: "product_label",
  });
  expect(malt.price!.pen / malt.price!.packageAmount).toBeCloseTo(0.01529, 10);
  expect(malt.adaptiveBounds).toBeNull();
  expect(malt.baseAmount).toBeNull();
  expect(malt.declaredIngredients).toContain("sucralose_SIN_955");
  expect(malt.declaredIngredients).toContain("dehydrated_orange");
  for (const activeProfile of ["legacy_v1", "future_v2"])
    expect(() =>
      parseGainerConfig({
        activeProfile,
        recipeProfiles: { future_v2: { ingredients: { maltodex: { enabled: true } } } },
      }),
    ).toThrow("proteinG");
});

test("base amounts are independent of each other and of label serving basis", () => {
  const config = futureBaseConfig();
  const oatsChanged = parseGainerConfig(
    mergeGainerConfig(config, { recipeProfiles: { future_v2: { ingredients: { quaker_oats: { baseAmount: 80 } } } } }),
  );
  expect(oatsChanged.recipeProfiles.future_v2!.ingredients.anchor!.baseAmount).toBe(30);
  const anchorChanged = parseGainerConfig(
    mergeGainerConfig(config, { recipeProfiles: { future_v2: { ingredients: { anchor: { baseAmount: 20 } } } } }),
  );
  expect(anchorChanged.recipeProfiles.future_v2!.ingredients.quaker_oats!.baseAmount).toBe(70);
  expect(resolveRecipe(oatsChanged).ingredients.find((i) => i.id === "quaker_oats")!.nutrition!.caloriesKcal).toBe(320);
  const result = calculateGainer(
    {
      date: summary.date,
      mode: "calories",
      targetCaloriesKcal: resolveRecipe(config).baseNutrition.caloriesKcal,
      sweetener: "none",
    },
    config,
    summary,
  );
  if (!("ingredients" in result)) throw new Error(result.reason);
  expect(result.ingredients[0]).toMatchObject({ exactG: 70, practicalG: 70 });
  expect(result.ingredients[1]).toMatchObject({ exactG: 30, practicalG: 30 });
});

test.each(["calories", "fitia_optimal", "fitia_adaptive"] as const)(
  "disabled product metadata is inert in %s, including evaluated candidates and carryover",
  (mode) => {
    const config = futureBaseConfig();
    const changed = structuredClone(config);
    changed.recipeProfiles.future_v2!.ingredients.maltodex = {
      ...maltodexCandidate(),
      baseAmount: 999,
      adaptiveBounds: { minFactor: 0, maxFactor: 10 },
      price: { pen: 90000, packageAmount: 1 },
      nutrition: {
        basisAmount: 1,
        source: "product_label",
        macros: { caloriesKcal: 9999, proteinG: null, carbsG: 999, fatG: 999 },
      },
    };
    const result = calculate(config, mode);
    expect("ingredients" in result).toBe(true);
    expect(operational(calculate(changed, mode))).toEqual(operational(result));
    const recipe = resolveRecipe(changed),
      amounts = scaledAmounts(1, recipe);
    expect(recipe.ingredients.some((i) => i.id === "maltodex")).toBe(false);
    expect(amounts.maltodex).toBeUndefined();
    expect(drySolidsG(amounts, recipe)).toBe(drySolidsG(amounts, resolveRecipe(config)));
    expect(waterForAmounts(amounts, recipe)).toBe(waterForAmounts(amounts, resolveRecipe(config)));
  },
);

test("any disabled historical ingredient is absent from future nutrition, cost, solids, and output", () => {
  const config = futureBaseConfig();
  config.recipeProfiles.future_v2!.ingredients.anchor!.enabled = false;
  const result = calculate(config);
  if (!("ingredients" in result)) throw new Error(result.reason);
  expect(result.ingredients.some((i) => i.id === "anchor")).toBe(false);
  const previous = operational(result);
  config.recipeProfiles.future_v2!.ingredients.anchor!.baseAmount = 900;
  config.recipeProfiles.future_v2!.ingredients.anchor!.price = { pen: 90000, packageAmount: 1 };
  expect(operational(calculate(config))).toEqual(previous);
});

test("profile switching restores the exact legacy behavior without resetting individual settings", () => {
  const config = futureBaseConfig();
  const result = calculate(config);
  expect(result.recipeId).toBe("polack_labs_mass_gainer_v2");
  const legacy = parseGainerConfig(mergeGainerConfig(config, { activeProfile: "legacy_v1" }));
  expect(operational(calculate(legacy))).toEqual(operational(calculate()));
  const restored = parseGainerConfig(mergeGainerConfig(legacy, { activeProfile: "future_v2" }));
  expect(calculate(restored)).toEqual(result);
});

test("future Anchor derives from structural water, never cycles, and adaptive respects concentration bounds", () => {
  // Synthetic ratios only: not a physical recommendation or a saved default.
  const config = parseGainerConfig({
    activeProfile: "future_v2",
    recipeProfiles: {
      future_v2: {
        ingredients: {
          anchor: { gramsPer100MlWater: 7, concentrationBounds: { min: 4, max: 9 } },
          nestum: { adaptiveBounds: { minFactor: 0.25, maxFactor: 2.5 } },
        },
      },
    },
  });
  const recipe = resolveRecipe(config);
  const amounts = scaledAmounts(1, recipe),
    water = waterForAmounts(amounts, recipe);
  expect(waterForAmounts({ ...amounts, anchor: 999 }, recipe)).toBe(water);
  expect(amounts.anchor).toBe(Math.round((water * 7) / 100));
  const result = calculate(config);
  if (!("ingredients" in result) || result.optimization?.mode !== "fitia_adaptive") throw new Error(result.reason);
  const ratio = (result.optimization.amounts!.anchor! * 100) / result.water.exactMl;
  expect(ratio).toBeGreaterThanOrEqual(4 - 1e-9);
  expect(ratio).toBeLessThanOrEqual(9 + 1e-9);
  expect(result.optimization.amounts!.nestum).toBeLessThanOrEqual(50);
  expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(
    config.recipeProfiles.future_v2!.adaptive.maxBatchCaloriesKcal,
  );
  expect(drySolidsG(result.optimization.amounts!, recipe)).toBeLessThanOrEqual(
    config.recipeProfiles.future_v2!.adaptive.maxDrySolidsG,
  );
  expect(calculate(config)).toEqual(result);
});

test("future snapshot reconstructs individual amounts and the same water after preferences change", () => {
  const config = futureBaseConfig();
  config.maxNightCaloriesKcal = 350;
  config.preferredNightCaloriesKcal = 300;
  const result = calculate(config);
  if (!("carryoverDraft" in result)) throw new Error("Expected synthetic split");
  const draft = carryoverDraftSchema.parse({ ...result.carryoverDraft, configVersion: "1" });
  const frozen = parseGainerConfig(JSON.parse(JSON.stringify(config)));
  const plan = makeCarryoverPlan(draft, frozen);
  config.recipeProfiles.future_v2!.ingredients.quaker_oats!.baseAmount = 90;
  expect(makeCarryoverPlan(draft, frozen).id).toBe(result.carryoverId);
  expect(plan.fullBatch.practicalNutrition).toEqual(result.practicalNutrition);
  expect(plan.fullBatch.water.practicalMl).toBe(result.water.practicalMl);
  expect(() => makeCarryoverPlan(draft, defaultGainerConfig())).toThrow("frozen profile");
});

test("future Anchor minima use actual structural water and may explicitly allow zero concentration", () => {
  // Stress fixture only, not a suggested physical dairy concentration.
  const config = parseGainerConfig({
    activeProfile: "future_v2",
    recipeProfiles: {
      future_v2: {
        adaptive: { maxDrySolidsG: 70 },
        ingredients: {
          anchor: { gramsPer100MlWater: 50, concentrationBounds: { min: 40, max: 60 } },
          nestum: { adaptiveBounds: { minFactor: 0.25, maxFactor: 2.5 } },
        },
      },
    },
  });
  const recipe = resolveRecipe(config),
    minimum = minimumAdaptiveAmounts(recipe.adaptive, recipe);
  expect(validAdaptiveAmounts(minimum, recipe.adaptive, recipe)).toBe(true);
  expect(drySolidsG(minimum, recipe)).toBeLessThanOrEqual(70);
  const result = calculate(config);
  if (!("ingredients" in result) || result.optimization?.mode !== "fitia_adaptive") throw new Error(result.reason);
  expect(drySolidsG(result.optimization.amounts!, recipe)).toBeLessThanOrEqual(70);
  const zero = parseGainerConfig(
    mergeGainerConfig(config, {
      recipeProfiles: { future_v2: { ingredients: { anchor: { concentrationBounds: { min: 0, max: 60 } } } } },
    }),
  );
  const zeroRecipe = resolveRecipe(zero);
  expect(minimumAdaptiveAmounts(zeroRecipe.adaptive, zeroRecipe).anchor).toBe(0);
});

test("calculator exposes compact effective metadata and preserves the complete configUsed contract", () => {
  const result = calculate();
  expect(result.configUsed).toEqual(defaultGainerConfig());
  expect(JSON.stringify(result.recipeProfile)).not.toContain("nutrition");
  expect(result.recipeProfile).toMatchObject({
    activeProfile: "legacy_v1",
    disabledIngredients: ["maltodex"],
    effectiveBaseAmounts: { quaker_oats: { amount: 50, unit: "g" }, anchor: { amount: 50, unit: "g" } },
  });
});

test("future complete synthetic carb product can participate independently; real candidate remains disabled", () => {
  // Deliberately different synthetic label; never assert a missing real protein value is zero.
  const config = futureBaseConfig();
  config.recipeProfiles.future_v2!.ingredients.maltodex = {
    ...maltodexCandidate(),
    name: "Synthetic carb fixture",
    enabled: true,
    baseAmount: 40,
    adaptiveBounds: { minFactor: 0, maxFactor: 3 },
    nutrition: {
      basisAmount: 40,
      macros: { caloriesKcal: 160, proteinG: 1, carbsG: 38, fatG: 0 },
      source: "product_label",
    },
  };
  const ready = parseGainerConfig(config),
    recipe = resolveRecipe(ready);
  const single = Object.fromEntries(recipe.ingredients.map((i) => [i.id, i.id === "maltodex" ? 40 : 0]));
  expect(amountsNutrition(single, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, recipe)).toEqual({
    caloriesKcal: 160,
    proteinG: 1,
    carbsG: 38,
    fatG: 0,
  });
  const result = calculate(ready);
  if (!("ingredients" in result) || result.optimization?.mode !== "fitia_adaptive") throw new Error(result.reason);
  expect(result.optimization.amounts!.maltodex).toBeGreaterThan(0);
  expect(Number.isInteger(result.optimization.amounts!.maltodex)).toBe(true);
  expect(result.optimization.amounts!.maltodex).toBeLessThanOrEqual(120);
  expect(result.sweetener.mode).toBe("none");
  expect(defaultGainerConfig().recipeProfiles.legacy_v1.ingredients.maltodex!.enabled).toBe(false);
  expect(result.scoringComponents).toMatchObject({ costPenalty: 0, practicalityPenalty: 0 });
});

test("future cost/practicality flags cannot silently enable unimplemented heuristics", () => {
  for (const flag of ["costOptimizationEnabled", "practicalityOptimizationEnabled"])
    expect(() => parseGainerConfig({ recipeProfiles: { future_v2: { [flag]: true } } })).toThrow();
});

test("future fixed carryover rejects out-of-bounds drafts and disabled adaptive quantities", () => {
  const config = futureBaseConfig();
  config.maxNightCaloriesKcal = 350;
  config.preferredNightCaloriesKcal = 300;
  expect(() =>
    makeCarryoverPlan(
      {
        sourceDate: summary.date,
        recipeId: "polack_labs_mass_gainer_v2",
        scaleFactor: 3,
        sweetener: "none",
        nightPercent: 10,
      },
      config,
    ),
  ).toThrow("profile bounds");
  const result = calculate(config);
  if (!("carryoverDraft" in result)) throw new Error("Expected synthetic split");
  expect(() =>
    makeCarryoverPlan(
      { ...result.carryoverDraft, adaptiveAmounts: { ...result.carryoverDraft.adaptiveAmounts, maltodex: 0 } },
      config,
    ),
  ).toThrow("saved configuration");
});

test("September 22 historical practical recipe, macros, water, split and immutable carryover ID", () => {
  const fixture = baseline.fixtures.find((f) => f.input.date === "2026-09-22")!;
  const result = calculateGainer(fixture.input as GainerInput, defaultGainerConfig(), fixture.day as DaySummary);
  if (!("carryoverDraft" in result)) throw new Error(result.reason);
  expect(result.ingredients.map((i) => ("practicalG" in i ? i.practicalG : i.practicalMl))).toEqual([
    75, 75, 30, 15, 7, 7, 1, 4,
  ]);
  expect(result.sweetener.practicalHoneyG).toBe(60);
  expect(result.water.practicalMl).toBe(890);
  expect(result.creatineG).toBe(5);
  expect(result.practicalNutrition).toEqual({
    caloriesKcal: 1046.64,
    proteinG: 30.0855,
    carbsG: 177.7175,
    fatG: 23.0525,
  });
  expect(result.nightPortion.percent).toBe(67);
  expect(result.morningCarryover.percent).toBe(33);
  expect(result.carryoverId).toBe("f79e67b4c8bbe25c713de395797afcfbc87922d2a8a398c998207ac5776ebdbb");
});

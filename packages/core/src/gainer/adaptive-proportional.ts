import { CliError } from "../errors.ts";
import { emptyMacros, type Macros, macroKeys, round } from "../nutrition.ts";
import { adaptiveSearchPolicy } from "./adaptive.ts";
import { type GreenRanges, optimizationPolicy, optimizeGainer, scoreGainer, states } from "./optimization.ts";
import { amountsNutrition, drySolidsG, quantity, scaledAmounts, scaleMacros } from "./portion.ts";
import type { RuntimeRecipe } from "./profiles.ts";
import {
  type AdaptiveConfig,
  adaptiveDerivedIds,
  adaptiveMainIds,
  type GainerConfig,
  gainerRecipe,
  type MainAmounts,
  proportionalAdaptiveDefaults,
  type RecipeAmounts,
  type SweetenerInventory,
} from "./recipe.ts";

export type ProportionalPreparation = {
  version: "proportional_v2";
  baselineScaleFactor: number;
  honeyTablespoons: number;
};
type Sweetener = Exclude<SweetenerInventory, "unknown">;

export function proportionalSettings(config: AdaptiveConfig, recipe: RuntimeRecipe) {
  if (recipe.profileId !== "legacy_v1")
    throw new CliError(
      "UNSUPPORTED_ADAPTIVE_PROFILE",
      "proportional_v2 currently supports the historical eight-ingredient recipe only.",
      "Keep future_v2 inactive; its experimental ingredients and water_ratio use the legacy strategy.",
    );
  const baseMainG = adaptiveMainIds.reduce((sum, id) => sum + recipe.ingredients.find((i) => i.id === id)!.amount, 0);
  const baseDryG = recipe.creatineG + recipe.ingredients.reduce((sum, i) => sum + (i.unit === "g" ? i.amount : 0), 0);
  return {
    ingredientDeviation: { ...proportionalAdaptiveDefaults.ingredientDeviation, ...config.ingredientDeviation },
    // Convert existing dry-solids hydration to the four-main-ingredient basis.
    // This preserves the configured base-batch water, including old custom ratios.
    waterMlPerMainDryGram: config.waterMlPerMainDryGram ?? (config.waterMlPerDryGram * baseDryG) / baseMainG,
    baseMainG,
  };
}

export function mainAmounts(amounts: RecipeAmounts): MainAmounts {
  return Object.fromEntries(adaptiveMainIds.map((id) => [id, quantity(amounts, id)])) as MainAmounts;
}
export function proportionalBounds(baseline: MainAmounts, config: AdaptiveConfig, recipe: RuntimeRecipe) {
  const settings = proportionalSettings(config, recipe);
  return adaptiveMainIds.map((id) => ({
    id,
    baseline: baseline[id],
    deviation: settings.ingredientDeviation[id],
    min: Math.max(0, Math.ceil(baseline[id] * (1 - settings.ingredientDeviation[id]) - 1e-9)),
    max: Math.floor(baseline[id] * (1 + settings.ingredientDeviation[id]) + 1e-9),
  }));
}
export function deriveProportionalBatch(main: MainAmounts, config: AdaptiveConfig, recipe: RuntimeRecipe) {
  const settings = proportionalSettings(config, recipe);
  const mainDryG = adaptiveMainIds.reduce((sum, id) => sum + main[id], 0),
    mainDryScale = mainDryG / settings.baseMainG;
  const amounts: RecipeAmounts = Object.fromEntries(
    recipe.ingredients.map((i) => [
      i.id,
      adaptiveMainIds.includes(i.id as (typeof adaptiveMainIds)[number])
        ? quantity(main, i.id)
        : Math.round(i.amount * mainDryScale),
    ]),
  );
  return { amounts, mainDryG, mainDryScale, waterMl: mainDryG * settings.waterMlPerMainDryGram };
}
export function honeyCandidates(mode: Sweetener, mainDryScale: number) {
  const configured = gainerRecipe.sweeteners[mode].honeyTablespoons;
  const targetTablespoons = mode === "honey_only" ? Math.round(configured * mainDryScale) : configured;
  return {
    targetTablespoons,
    candidateTablespoons:
      mode === "honey_only"
        ? [...new Set([Math.max(0, targetTablespoons - 1), targetTablespoons, targetTablespoons + 1])]
        : [configured],
  };
}
export function proportionalHoney(tablespoons: number, config: GainerConfig) {
  const honeyG = tablespoons * config.honeyGramsPerTablespoon,
    practicalHoneyG = Math.round(honeyG);
  return {
    honeyG,
    practicalHoneyG,
    exact: scaleMacros(config.honeyProfile.per100G, honeyG / 100),
    practical: scaleMacros(config.honeyProfile.per100G, practicalHoneyG / 100),
  };
}
export function proportionalDeviation(main: MainAmounts, baseline: MainAmounts, config: AdaptiveConfig) {
  return (
    (config.deviationWeight *
      adaptiveMainIds.reduce((sum, id) => sum + Math.abs(main[id] - baseline[id]) / Math.max(baseline[id], 1), 0)) /
    adaptiveMainIds.length
  );
}

// Saved new batches are validated using their versioned baseline and exact whole
// amounts. This is never used to reinterpret old carryover drafts.
export function validateProportionalPreparation(
  amounts: RecipeAmounts,
  preparation: ProportionalPreparation,
  mode: Sweetener,
  config: GainerConfig,
  recipe: RuntimeRecipe,
) {
  const baseline = mainAmounts(scaledAmounts(preparation.baselineScaleFactor, recipe));
  const main = mainAmounts(amounts),
    batch = deriveProportionalBatch(main, recipe.adaptive, recipe);
  const honey = honeyCandidates(mode, batch.mainDryScale);
  const nutrition = proportionalHoney(preparation.honeyTablespoons, config);
  const valid =
    Number.isFinite(preparation.baselineScaleFactor) &&
    preparation.baselineScaleFactor > 0 &&
    Object.keys(amounts).length === recipe.ingredients.length &&
    Object.keys(amounts).every((id) => recipe.ingredients.some((i) => i.id === id)) &&
    proportionalBounds(baseline, recipe.adaptive, recipe).every(
      (b) => Number.isInteger(main[b.id]) && main[b.id] >= b.min && main[b.id] <= b.max,
    ) &&
    recipe.ingredients.every((i) => quantity(amounts, i.id) === quantity(batch.amounts, i.id)) &&
    batch.mainDryG > 0 &&
    honey.candidateTablespoons.includes(preparation.honeyTablespoons) &&
    drySolidsG(amounts, recipe) <= recipe.adaptive.maxDrySolidsG &&
    Math.max(
      amountsNutrition(amounts, nutrition.exact, recipe).caloriesKcal,
      amountsNutrition(amounts, nutrition.practical, recipe).caloriesKcal,
    ) <=
      recipe.adaptive.maxBatchCaloriesKcal + optimizationPolicy.numericTolerance;
  if (!valid)
    throw new CliError(
      "INVALID_ADAPTIVE_BATCH",
      "Proportional adaptive quantities, honey or limits do not match the frozen preparation.",
      "Use the complete unchanged draft returned by the calculator.",
    );
  return batch;
}

export function optimizeProportionalAdaptive(
  consumed: Macros,
  ranges: GreenRanges,
  mode: Sweetener,
  config: GainerConfig,
  recipe: RuntimeRecipe,
) {
  const settings = proportionalSettings(recipe.adaptive, recipe),
    adaptive = recipe.adaptive;
  const configuredHoney = proportionalHoney(gainerRecipe.sweeteners[mode].honeyTablespoons, config);
  const fixed = optimizeGainer(consumed, ranges, configuredHoney.exact, configuredHoney.practical, recipe);
  let reference = fixed,
    baselineSource = "fitia_optimal";
  const before = states(consumed, ranges),
    allGreenBefore = macroKeys.every((k) => before[k] === "green");
  // The old fixed honey may not fit a tiny batch. Its no-honey proportional
  // reference allows the explicitly permitted discrete honey choices, not a
  // free-form fallback or a change to fitia_optimal itself.
  if (!allGreenBefore && fixed.scaleFactor === 0 && mode === "honey_only") {
    reference = optimizeGainer(consumed, ranges, emptyMacros(), emptyMacros(), recipe);
    baselineSource = "fitia_optimal_without_honey";
  }
  const baseline = mainAmounts(scaledAmounts(reference.scaleFactor, recipe));
  const bounds = proportionalBounds(baseline, adaptive, recipe);
  const maxAdditionalCalories = Math.max(0, ranges.caloriesKcal.max - consumed.caloriesKcal);
  const budget = Math.min(maxAdditionalCalories, adaptive.maxBatchCaloriesKcal);
  const score = (nutrition: Macros) =>
    scoreGainer(consumed, ranges, nutrition, adaptive.metricWeights, adaptive.alreadyHighMultipliers);
  const noDrink = score(emptyMacros());
  const fixedAmounts = scaledAmounts(fixed.scaleFactor, recipe);
  const fixedNutrition =
    fixed.scaleFactor > 0 ? amountsNutrition(fixedAmounts, configuredHoney.practical, recipe) : emptyMacros();
  type Candidate = {
    main: MainAmounts;
    batch: ReturnType<typeof deriveProportionalBatch>;
    tablespoons: number;
    nutrition: Macros;
    score: ReturnType<typeof score>;
    deviation: number;
    total: number;
  };
  const evaluated = new Map<string, Candidate | null>();
  let feasibleCandidates = 0;
  const improves = (a: Candidate, b: Candidate | null) =>
    a.total < (b?.total ?? noDrink.total) - optimizationPolicy.scoreTieTolerance;
  const evaluate = (main: MainAmounts): Candidate | null => {
    const batch = deriveProportionalBatch(main, adaptive, recipe);
    const physicallyValid =
      bounds.every((b) => Number.isInteger(main[b.id]) && main[b.id] >= b.min && main[b.id] <= b.max) &&
      batch.mainDryG > 0 &&
      drySolidsG(batch.amounts, recipe) <= adaptive.maxDrySolidsG;
    // Invalid coordinate probes do not create negative/meaningless honey doses.
    if (!physicallyValid) return null;
    let best: Candidate | null = null;
    for (const tablespoons of honeyCandidates(mode, batch.mainDryScale).candidateTablespoons) {
      const key = [...adaptiveMainIds.map((id) => main[id]), tablespoons].join(",");
      let candidate = evaluated.get(key);
      if (candidate === undefined) {
        if (evaluated.size >= adaptiveSearchPolicy.maxCandidates) break;
        candidate = null;
        const honey = proportionalHoney(tablespoons, config),
          nutrition = amountsNutrition(batch.amounts, honey.practical, recipe),
          exact = amountsNutrition(batch.amounts, honey.exact, recipe);
        if (Math.max(nutrition.caloriesKcal, exact.caloriesKcal) <= budget + optimizationPolicy.numericTolerance) {
          const scored = score(nutrition),
            deviation = proportionalDeviation(main, baseline, adaptive);
          candidate = {
            main,
            batch,
            tablespoons,
            nutrition,
            score: scored,
            deviation,
            total: scored.total + deviation,
          };
          feasibleCandidates++;
        }
        evaluated.set(key, candidate);
      }
      if (candidate && (!best || candidate.total < best.total - optimizationPolicy.scoreTieTolerance)) best = candidate;
    }
    return best;
  };
  let best: Candidate | null = null;
  if (!allGreenBefore && reference.scaleFactor > 0) {
    const minimum = Object.fromEntries(bounds.map((b) => [b.id, b.min])) as MainAmounts;
    const maximum = Object.fromEntries(bounds.map((b) => [b.id, b.max])) as MainAmounts;
    for (const seed of [minimum, baseline, maximum]) {
      const starting = evaluate(seed);
      if (!starting) continue;
      let current: Candidate = starting;
      for (const step of adaptiveSearchPolicy.steps)
        for (let pass = 0; pass < adaptiveSearchPolicy.passesPerStep; pass++) {
          let next: Candidate = current;
          const consider = (main: MainAmounts) => {
            const candidate = evaluate(main);
            if (candidate && candidate.total < next.total - optimizationPolicy.scoreTieTolerance) next = candidate;
          };
          for (const id of adaptiveMainIds)
            for (const direction of [-1, 1]) {
              const delta = step * direction;
              consider({ ...current.main, [id]: current.main[id] + delta });
              for (const other of adaptiveMainIds)
                if (id !== other) {
                  const i = recipe.ingredients.find((i) => i.id === id)!,
                    j = recipe.ingredients.find((i) => i.id === other)!;
                  const exchange =
                    (delta * (i.nutrition!.caloriesKcal / i.amount)) / (j.nutrition!.caloriesKcal / j.amount);
                  for (const adjustment of new Set([Math.floor(exchange), Math.ceil(exchange)]))
                    consider({
                      ...current.main,
                      [id]: current.main[id] + delta,
                      [other]: current.main[other] - adjustment,
                    });
                }
            }
          if (next === current) break;
          current = next;
        }
      if (improves(current, best)) best = current;
    }
  }
  const chosen = best,
    after = chosen?.score ?? noDrink;
  const allGreen = macroKeys.every((k) => after.states[k] === "green");
  const nextGramCalories = Math.min(
    ...adaptiveMainIds.map((id) => {
      const i = recipe.ingredients.find((i) => i.id === id)!;
      return i.nutrition!.caloriesKcal / i.amount;
    }),
  );
  const calorieLimited = !!chosen && !allGreen && budget - chosen.nutrition.caloriesKcal < nextGramCalories;
  const outcome = allGreenBefore
    ? "not_needed"
    : !chosen
      ? "not_beneficial"
      : allGreen
        ? "all_green"
        : calorieLimited
          ? "limited_by_calories"
          : "best_available";
  const scale = chosen
    ? amountsNutrition(chosen.batch.amounts, emptyMacros(), recipe).caloriesKcal / recipe.baseNutrition.caloriesKcal
    : 0;
  const preparation: ProportionalPreparation | null = chosen
    ? { version: "proportional_v2", baselineScaleFactor: reference.scaleFactor, honeyTablespoons: chosen.tablespoons }
    : null;
  const reason = allGreenBefore
    ? "Las cuatro métricas ya están en verde; no hace falta añadir un batido."
    : !chosen
      ? "Ninguna variación medible del lote proporcional mejora el balance dentro de los límites dinámicos, físicos y calóricos."
      : `Se ajustan solo avena, Anchor, Nestum y 7 Cereales dentro de los límites del lote proporcional del día; saborizantes y agua siguen su tamaño físico. ${allGreen ? "Las cuatro métricas quedan en verde." : "Es el mejor compromiso encontrado; quedan métricas fuera de verde."}`;
  return {
    mode: "fitia_adaptive" as const,
    scaleFactor: scale,
    amounts: chosen?.batch.amounts ?? null,
    preparation,
    outcome,
    before,
    after: after.states,
    improvedMetrics: macroKeys.filter(
      (k) => before[k] === "low" && after.values[k] > consumed[k] + optimizationPolicy.numericTolerance,
    ),
    enteredGreen: macroKeys.filter((k) => before[k] !== "green" && after.states[k] === "green"),
    leftGreen: macroKeys.filter((k) => before[k] === "green" && after.states[k] !== "green"),
    reason,
    maxAdditionalCaloriesKcal: round(maxAdditionalCalories),
    score: {
      before: noDrink.total,
      after: chosen?.total ?? noDrink.total,
      nutritionAfter: after.total,
      penalties: after.penalties,
      extraCalories: after.extraCalories,
    },
    scoringBasis: "practical_quantities" as const,
    practicalValidated: true,
    evaluatedCandidates: evaluated.size,
    feasibleCandidates,
    adaptive: {
      strategy: "proportional_v2" as const,
      baseline,
      baselineScaleFactor: reference.scaleFactor,
      baselineSource,
      bounds,
      ingredientAdjustments: chosen
        ? adaptiveMainIds.map((id) => ({
            id,
            baselineG: baseline[id],
            practicalG: chosen.main[id],
            deltaG: chosen.main[id] - baseline[id],
          }))
        : [],
      derivedIngredients: chosen
        ? {
            mainDryScale: chosen.batch.mainDryScale,
            mainDryG: chosen.batch.mainDryG,
            ...Object.fromEntries(adaptiveDerivedIds.map((id) => [id, quantity(chosen.batch.amounts, id)])),
            waterMl: chosen.batch.waterMl,
            waterPracticalMl: Math.round(chosen.batch.waterMl / 10) * 10,
          }
        : null,
      honey: chosen
        ? { ...honeyCandidates(mode, chosen.batch.mainDryScale), selectedTablespoons: chosen.tablespoons }
        : null,
      deviationPenalty: chosen?.deviation ?? 0,
      scaleFactorMeaning: "calorie_equivalent_only; use individual ingredient amounts, never multiply the base recipe",
      config: { ...adaptive, ...settings },
      search: adaptiveSearchPolicy,
      searchBudgetReached: evaluated.size >= adaptiveSearchPolicy.maxCandidates,
      comparison: {
        scoringBasis: "both recipes evaluated with the adaptive nutrition weights; lower is better",
        fixedProportions: {
          nutrition: fixedNutrition,
          nutritionScore: score(fixedNutrition).total,
          deviationPenalty:
            fixed.scaleFactor > 0 ? proportionalDeviation(mainAmounts(fixedAmounts), baseline, adaptive) : 0,
          withinAdaptiveBounds:
            fixed.scaleFactor > 0 &&
            bounds.every((b) => quantity(fixedAmounts, b.id) >= b.min && quantity(fixedAmounts, b.id) <= b.max) &&
            drySolidsG(fixedAmounts, recipe) <= adaptive.maxDrySolidsG &&
            fixedNutrition.caloriesKcal <= budget,
        },
        adaptiveNutritionScore: after.total,
      },
    },
  };
}

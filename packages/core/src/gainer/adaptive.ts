import { emptyMacros, type Macros, macroKeys, round } from "../nutrition.ts";
import { type GreenRanges, optimizationPolicy, optimizeGainer, scoreGainer, states } from "./optimization.ts";
import { amountsNutrition, drySolidsG, portionNutrition } from "./portion.ts";
import { type AdaptiveConfig, baseMixNutrition, type GainerAmounts, gainerRecipe } from "./recipe.ts";

// Fixed work budget and traversal order: identical inputs always produce identical output.
export const adaptiveSearchPolicy = { steps: [8, 4, 2, 1], passesPerStep: 16, maxCandidates: 18000 } as const;
const ingredients = gainerRecipe.ingredients;

export function adaptiveBounds(config: AdaptiveConfig) {
  return ingredients.map((i) => ({
    id: i.id,
    min: Math.ceil(i.amount * config.bounds[i.id].minFactor - 1e-9),
    max: Math.floor(i.amount * config.bounds[i.id].maxFactor + 1e-9),
  }));
}

export function validAdaptiveAmounts(amounts: GainerAmounts, config: AdaptiveConfig) {
  return (
    adaptiveBounds(config).every(
      (b) => Number.isInteger(amounts[b.id]) && amounts[b.id] >= b.min && amounts[b.id] <= b.max,
    ) &&
    ingredients.some((i) => i.nutrition && amounts[i.id] > 0) &&
    drySolidsG(amounts) <= config.maxDrySolidsG
  );
}

export function adaptiveDeviation(amounts: GainerAmounts, config: AdaptiveConfig) {
  const scale = amountsNutrition(amounts, emptyMacros()).caloriesKcal / baseMixNutrition.caloriesKcal;
  return (
    (config.deviationWeight *
      ingredients.reduce(
        (sum, i) => sum + Math.abs(amounts[i.id] - i.amount * scale) / Math.max(i.amount * scale, 1),
        0,
      )) /
    ingredients.length
  );
}

export function optimizeAdaptive(
  consumed: Macros,
  ranges: GreenRanges,
  sweetener: Macros,
  practicalSweetener: Macros,
  config: AdaptiveConfig,
) {
  const before = states(consumed, ranges);
  const maxAdditionalCalories = Math.max(0, ranges.caloriesKcal.max - consumed.caloriesKcal);
  const budget = Math.min(maxAdditionalCalories, config.maxBatchCaloriesKcal);
  const score = (nutrition: Macros) =>
    scoreGainer(consumed, ranges, nutrition, config.metricWeights, config.alreadyHighMultipliers);
  const baseline = score(emptyMacros());
  const fixed = optimizeGainer(consumed, ranges, sweetener, practicalSweetener);
  const fixedAmounts = Object.fromEntries(
    ingredients.map((i) => [i.id, Math.round(i.amount * fixed.scaleFactor)]),
  ) as GainerAmounts;
  const fixedNutrition =
    fixed.scaleFactor > 0
      ? portionNutrition(fixed.scaleFactor, sweetener, practicalSweetener).practical
      : emptyMacros();
  const bounds = adaptiveBounds(config);
  const clamp = (scale: number) =>
    Object.fromEntries(
      bounds.map((b, n) => [b.id, Math.min(b.max, Math.max(b.min, Math.round(ingredients[n]!.amount * scale)))]),
    ) as GainerAmounts;
  const evaluated = new Map<string, Candidate | null>();
  type Candidate = {
    amounts: GainerAmounts;
    nutrition: Macros;
    score: ReturnType<typeof score>;
    deviation: number;
    total: number;
  };
  let feasibleCandidates = 0;
  const evaluate = (amounts: GainerAmounts): Candidate | null => {
    const key = ingredients.map((i) => amounts[i.id]).join(",");
    if (evaluated.has(key)) return evaluated.get(key)!;
    if (evaluated.size >= adaptiveSearchPolicy.maxCandidates) return null;
    let candidate: Candidate | null = null;
    if (validAdaptiveAmounts(amounts, config)) {
      const nutrition = amountsNutrition(amounts, practicalSweetener);
      const exact = amountsNutrition(amounts, sweetener);
      if (Math.max(nutrition.caloriesKcal, exact.caloriesKcal) <= budget + optimizationPolicy.numericTolerance) {
        const result = score(nutrition),
          deviation = adaptiveDeviation(amounts, config);
        candidate = { amounts, nutrition, score: result, deviation, total: result.total + deviation };
        feasibleCandidates++;
      }
    }
    evaluated.set(key, candidate);
    return candidate;
  };
  const improves = (a: Candidate, b: Candidate | null) =>
    a.total < (b?.total ?? baseline.total) - optimizationPolicy.scoreTieTolerance;
  let best: Candidate | null = null;
  const allGreenBefore = macroKeys.every((key) => before[key] === "green");
  // Three deterministic starting points: minimum, legacy solution, and a calorie-lower-band recipe.
  // The minimum is componentwise cheapest, so if it cannot fit, no allowed recipe can fit.
  const minimumAmounts = clamp(0);
  const minimum = evaluate(minimumAmounts);
  const starts = minimum
    ? [minimum]
    : ingredients
        .filter((i) => i.nutrition)
        .map((i) => evaluate({ ...minimumAmounts, [i.id]: minimumAmounts[i.id] + 1 }))
        .filter((candidate) => candidate !== null);
  if (!allGreenBefore && starts.length) {
    const seeds = [
      ...starts,
      evaluate(clamp(fixed.scaleFactor)),
      evaluate(
        clamp(
          Math.max(0, ranges.caloriesKcal.min - consumed.caloriesKcal - practicalSweetener.caloriesKcal) /
            baseMixNutrition.caloriesKcal,
        ),
      ),
    ];
    for (const seed of seeds) {
      if (!seed) continue;
      let current = seed;
      for (const step of adaptiveSearchPolicy.steps) {
        for (let pass = 0; pass < adaptiveSearchPolicy.passesPerStep; pass++) {
          let next = current;
          const consider = (amounts: GainerAmounts) => {
            const candidate = evaluate(amounts);
            if (candidate && improves(candidate, next)) next = candidate;
          };
          for (const i of ingredients) {
            for (const direction of [-1, 1]) {
              const delta = step * direction;
              consider({ ...current.amounts, [i.id]: current.amounts[i.id] + delta });
              // Calorie-balanced pair exchanges can improve a recipe at a hard calorie ceiling.
              if (i.nutrition)
                for (const j of ingredients) {
                  if (i.id === j.id || !j.nutrition) continue;
                  const exchange =
                    (delta * (i.nutrition.caloriesKcal / i.amount)) / (j.nutrition.caloriesKcal / j.amount);
                  for (const adjustment of new Set([Math.floor(exchange), Math.ceil(exchange)]))
                    consider({
                      ...current.amounts,
                      [i.id]: current.amounts[i.id] + delta,
                      [j.id]: current.amounts[j.id] - adjustment,
                    });
                }
            }
          }
          if (next === current) break;
          current = next;
        }
      }
      if (improves(current, best)) best = current;
    }
  }
  const after = best?.score ?? baseline;
  const improvedMetrics = macroKeys.filter(
    (key) => before[key] === "low" && after.values[key] > consumed[key] + optimizationPolicy.numericTolerance,
  );
  const enteredGreen = macroKeys.filter((key) => before[key] !== "green" && after.states[key] === "green");
  const leftGreen = macroKeys.filter((key) => before[key] === "green" && after.states[key] !== "green");
  const allGreen = macroKeys.every((key) => after.states[key] === "green");
  const nextGramCalories = Math.min(
    ...ingredients.filter((i) => i.nutrition).map((i) => i.nutrition!.caloriesKcal / i.amount),
  );
  const calorieLimited = !!best && !allGreen && budget - best.nutrition.caloriesKcal < nextGramCalories;
  const outcome = allGreenBefore
    ? "not_needed"
    : !best
      ? "not_beneficial"
      : allGreen
        ? "all_green"
        : calorieLimited
          ? "limited_by_calories"
          : "best_available";
  const chosen = best;
  const adjustments = chosen
    ? ingredients.map((i) => ({
        id: i.id,
        name: i.name,
        ...(i.unit === "g"
          ? { baseG: i.amount, practicalG: chosen.amounts[i.id] }
          : { baseMl: i.amount, practicalMl: chosen.amounts[i.id] }),
        factor: chosen.amounts[i.id] / i.amount,
      }))
    : [];
  const labels = { caloriesKcal: "calorías", proteinG: "proteína", carbsG: "carbohidratos", fatG: "grasa" };
  const low = macroKeys.filter((key) => before[key] === "low").map((key) => labels[key]);
  const high = macroKeys.filter((key) => before[key] === "high").map((key) => labels[key]);
  const scale = chosen
    ? amountsNutrition(chosen.amounts, emptyMacros()).caloriesKcal / baseMixNutrition.caloriesKcal
    : 0;
  const raised = chosen
    ? ingredients.filter((i) => chosen.amounts[i.id] > i.amount * scale + 0.5).map((i) => i.name)
    : [];
  const reduced = chosen
    ? ingredients.filter((i) => chosen.amounts[i.id] < i.amount * scale - 0.5).map((i) => i.name)
    : [];
  const reason = allGreenBefore
    ? "Las cuatro métricas ya están en verde; no hace falta añadir un batido."
    : !chosen
      ? "Ninguna receta medible encontrada dentro de los límites y con estos endulzantes mejora el balance frente a omitir el batido."
      : `Bajos: ${low.join(", ") || "ninguno"}; altos: ${high.join(", ") || "ninguno"}. La búsqueda ajusta proporciones con penalización adicional al añadir proteína/grasa ya altas. Frente a una mezcla proporcional de las mismas kcal, aumenta ${raised.join(", ") || "ningún ingrediente"} y reduce ${reduced.join(", ") || "ningún ingrediente"}. ${allGreen ? "Las cuatro métricas quedan en verde." : "Es el mejor compromiso encontrado; quedan métricas fuera de verde."}`;
  return {
    mode: "fitia_adaptive" as const,
    scaleFactor: scale,
    amounts: chosen?.amounts ?? null,
    outcome,
    before,
    after: after.states,
    improvedMetrics,
    enteredGreen,
    leftGreen,
    reason,
    maxAdditionalCaloriesKcal: round(maxAdditionalCalories),
    score: {
      before: baseline.total,
      after: chosen?.total ?? baseline.total,
      nutritionAfter: after.total,
      penalties: after.penalties,
      extraCalories: after.extraCalories,
    },
    scoringBasis: "practical_quantities" as const,
    practicalValidated: true,
    evaluatedCandidates: evaluated.size,
    feasibleCandidates,
    adaptive: {
      ingredientAdjustments: adjustments,
      deviationPenalty: chosen?.deviation ?? 0,
      scaleFactorMeaning: "calorie_equivalent_only; use individual ingredient amounts, never multiply the base recipe",
      bounds,
      config,
      search: adaptiveSearchPolicy,
      searchBudgetReached: evaluated.size >= adaptiveSearchPolicy.maxCandidates,
      comparison: {
        scoringBasis: "both recipes evaluated with the adaptive nutrition weights; lower is better",
        fixedProportions: {
          nutrition: fixedNutrition,
          nutritionScore: score(fixedNutrition).total,
          deviationPenalty: fixed.scaleFactor > 0 ? adaptiveDeviation(fixedAmounts, config) : 0,
          withinAdaptiveBounds:
            fixed.scaleFactor > 0 &&
            validAdaptiveAmounts(fixedAmounts, config) &&
            fixedNutrition.caloriesKcal <= budget,
        },
        adaptiveNutritionScore: after.total,
      },
    },
  };
}

import { emptyMacros, type Macros, type MaybeMacros, macroKeys, round } from "../nutrition.ts";
import { fitsProfile, portionNutrition, scaledAmounts } from "./portion.ts";
import { legacyRuntimeRecipe } from "./profiles.ts";

// Explicit MCP convention, not inferred from Fitia's UI. Internal policy, not user preferences.
export const GREEN_RANGE_LOWER = 0.9;
export const GREEN_RANGE_UPPER = 1.1;
export const optimizationPolicy = {
  metricWeights: { caloriesKcal: 4, proteinG: 1, carbsG: 1, fatG: 1 },
  outsideRangePenalty: 0.05,
  excessWeight: 0.5,
  alreadyHighIncrementWeight: 0.1,
  extraCaloriesWeight: 0.005,
  scoreTieTolerance: 1e-6,
  numericTolerance: 1e-6,
  maxRoundingStepsPerIngredient: 1024,
} as const;

type Metric = (typeof macroKeys)[number];
export type GreenRanges = Record<Metric, { target: number; min: number; max: number }>;
type MetricStates = Record<Metric, "low" | "green" | "high">;

export function greenRanges(goals: MaybeMacros): GreenRanges | null {
  if (macroKeys.some((key) => goals[key] === null || !Number.isFinite(goals[key]) || goals[key]! < 0)) return null;
  return Object.fromEntries(
    macroKeys.map((key) => [
      key,
      { target: goals[key]!, min: round(goals[key]! * GREEN_RANGE_LOWER), max: round(goals[key]! * GREEN_RANGE_UPPER) },
    ]),
  ) as GreenRanges;
}

export function states(values: Macros, ranges: GreenRanges): MetricStates {
  return Object.fromEntries(
    macroKeys.map((key) => [
      key,
      values[key] < ranges[key].min - optimizationPolicy.numericTolerance
        ? "low"
        : values[key] > ranges[key].max + optimizationPolicy.numericTolerance
          ? "high"
          : "green",
    ]),
  ) as MetricStates;
}

export function scoreGainer(
  consumed: Macros,
  ranges: GreenRanges,
  drink: Macros,
  metricWeights: Macros = optimizationPolicy.metricWeights,
  alreadyHighMultipliers: Macros = { caloriesKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 },
) {
  const penalties = emptyMacros();
  const after = emptyMacros();
  for (const key of macroKeys) {
    after[key] = round(consumed[key] + drink[key]);
    const { min, max, target } = ranges[key];
    const deficit = Math.max(0, min - after[key]);
    const excess = Math.max(0, after[key] - max);
    const originalExcess = Math.max(0, consumed[key] - max);
    const excessPenalty =
      originalExcess > 0
        ? originalExcess * optimizationPolicy.excessWeight +
          Math.max(0, excess - originalExcess) *
            optimizationPolicy.alreadyHighIncrementWeight *
            alreadyHighMultipliers[key]
        : excess * optimizationPolicy.excessWeight;
    penalties[key] =
      metricWeights[key] *
      ((deficit + excessPenalty) / Math.max(target, 1) +
        (Math.max(deficit, excess) > optimizationPolicy.numericTolerance ? optimizationPolicy.outsideRangePenalty : 0));
  }
  const extraCalories =
    (optimizationPolicy.extraCaloriesWeight * drink.caloriesKcal) / Math.max(ranges.caloriesKcal.target, 1);
  return {
    total: macroKeys.reduce((sum, key) => sum + penalties[key], extraCalories),
    penalties,
    extraCalories,
    states: states(after, ranges),
    values: after,
  };
}

export function optimizeGainer(
  consumed: Macros,
  ranges: GreenRanges,
  sweetener: Macros,
  practicalSweetener: Macros,
  recipe = legacyRuntimeRecipe(),
) {
  const baseMixNutrition = recipe.baseNutrition;
  const before = states(consumed, ranges);
  const maxAdditionalCalories = Math.max(0, ranges.caloriesKcal.max - consumed.caloriesKcal);
  const maxScale = Math.max(0, (maxAdditionalCalories - sweetener.caloriesKcal) / baseMixNutrition.caloriesKcal);
  const score = (drink: Macros) => scoreGainer(consumed, ranges, drink);
  // Zero means no drink: no honey, packets, creatine, water or logging payload.
  const baseline = score(emptyMacros());
  let best = { scale: 0, score: baseline };
  const candidates = new Set<number>([maxScale]);
  const add = (scale: number) => {
    if (scale > 0 && scale <= maxScale) candidates.add(scale);
  };
  const nutritionIngredients = recipe.ingredients.filter((i) => i.nutrition);
  const breakpoints = [maxScale];
  for (const key of macroKeys)
    for (const bound of [ranges[key].min, ranges[key].max]) {
      const scale = (bound - consumed[key] - sweetener[key]) / baseMixNutrition[key];
      add(scale);
      if (scale > 0 && scale < maxScale) breakpoints.push(scale);
    }
  for (const ingredient of nutritionIngredients) {
    // Whole-gram transitions cover every practical serving for ordinary daily budgets.
    // Bound work for pathological large targets; also sample neighboring transitions at every green boundary.
    const transitions = Math.floor(maxScale * ingredient.amount + 0.5);
    const stride = Math.max(1, Math.ceil(transitions / optimizationPolicy.maxRoundingStepsPerIngredient));
    for (let n = 0; n < transitions; n += stride) add((n + 0.5) / ingredient.amount + 1e-10);
    for (const breakpoint of breakpoints)
      for (const offset of [-2, -1, 0, 1, 2])
        add((Math.floor(breakpoint * ingredient.amount) + offset + 0.5) / ingredient.amount + 1e-10);
  }
  let feasibleCandidates = 1;
  for (const scale of [...candidates].sort((a, b) => a - b)) {
    if (!nutritionIngredients.some((i) => Math.round(i.amount * scale) > 0)) continue;
    const { exact, practical } = portionNutrition(scale, sweetener, practicalSweetener, recipe);
    if (
      !fitsProfile(scaledAmounts(scale, recipe), practical, recipe) ||
      (recipe.profileId !== "legacy_v1" && exact.caloriesKcal > recipe.adaptive.maxBatchCaloriesKcal)
    )
      continue;
    // Both representations must respect the calorie ceiling; never rely on an overshoot warning to pass.
    if (
      Math.max(exact.caloriesKcal, practical.caloriesKcal) >
      maxAdditionalCalories + optimizationPolicy.numericTolerance
    )
      continue;
    feasibleCandidates++;
    const evaluated = score(practical);
    if (evaluated.total < best.score.total - optimizationPolicy.scoreTieTolerance) best = { scale, score: evaluated };
  }
  const improvedMetrics = macroKeys.filter(
    (key) => before[key] === "low" && best.score.values[key] > consumed[key] + optimizationPolicy.numericTolerance,
  );
  const enteredGreen = macroKeys.filter((key) => before[key] !== "green" && best.score.states[key] === "green");
  const leftGreen = macroKeys.filter((key) => before[key] === "green" && best.score.states[key] !== "green");
  const allGreenBefore = macroKeys.every((key) => before[key] === "green");
  const allGreenAfter = macroKeys.every((key) => best.score.states[key] === "green");
  const stillLow = macroKeys.some((key) => best.score.states[key] === "low");
  // Can the next measurable serving fit? Use the same rounding/nutrition function as the returned portion.
  const nextScale = Math.min(
    ...nutritionIngredients.map((i) => (Math.round(i.amount * best.scale) + 0.5) / i.amount + 1e-10),
  );
  const next = portionNutrition(nextScale, sweetener, practicalSweetener, recipe);
  const calorieLimited =
    stillLow &&
    Math.max(next.exact.caloriesKcal, next.practical.caloriesKcal) >
      maxAdditionalCalories + optimizationPolicy.numericTolerance;
  const outcome = allGreenBefore
    ? "not_needed"
    : best.scale === 0
      ? "not_beneficial"
      : allGreenAfter
        ? "all_green"
        : calorieLimited
          ? "limited_by_calories"
          : "best_available";
  const reason = allGreenBefore
    ? "Las cuatro métricas ya están en el rango verde; no hace falta añadir un batido para acercarse al 100%."
    : best.scale === 0
      ? "Ninguna porción medible con estos endulzantes mejora el balance de los rangos verdes dentro del margen calórico."
      : allGreenAfter
        ? "La porción práctica más pequeña entre los mejores candidatos deja las cuatro métricas en verde."
        : calorieLimited
          ? "La porción mejora los déficits; una porción mayor rebasaría el límite verde de calorías. Quedan métricas fuera de rango."
          : "Es el mejor compromiso encontrado: mejora déficits sin perseguir el 100%, considerando también los excesos de macros.";
  return {
    scaleFactor: best.scale,
    mode: "fitia_optimal" as const,
    outcome,
    before,
    after: best.score.states,
    improvedMetrics,
    enteredGreen,
    leftGreen,
    maxAdditionalCaloriesKcal: round(maxAdditionalCalories),
    reason,
    score: {
      before: baseline.total,
      after: best.score.total,
      penalties: best.score.penalties,
      extraCalories: best.score.extraCalories,
    },
    policy: { greenRangeLower: GREEN_RANGE_LOWER, greenRangeUpper: GREEN_RANGE_UPPER, ...optimizationPolicy },
    scoringBasis: "practical_quantities" as const,
    practicalValidated: true,
    evaluatedCandidates: feasibleCandidates,
  };
}

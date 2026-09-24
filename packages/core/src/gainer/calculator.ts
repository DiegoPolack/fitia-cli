import { validateDate } from "../diary.ts";
import { CliError } from "../errors.ts";
import {
  type DaySummary,
  difference,
  emptyMacros,
  type Macros,
  type MaybeMacros,
  macroKeys,
  round,
} from "../nutrition.ts";
import { optimizeAdaptive } from "./adaptive.ts";
import { optimizeProportionalAdaptive, proportionalHoney } from "./adaptive-proportional.ts";
import { type CarryoverContext, carryoverContext, planningDay } from "./carryover.ts";
import { greenRanges, optimizeGainer } from "./optimization.ts";
import {
  amountsNutrition,
  fitsProfile,
  portionNutrition,
  quantity,
  roundedMacros as rounded,
  scaledAmounts,
  scaleMacros,
  waterForAmounts,
} from "./portion.ts";
import { type ProfileIngredientId, resolveRecipe } from "./profiles.ts";
import { type GainerConfig, type GainerMode, gainerRecipe, type SweetenerMode, sweetenerModes } from "./recipe.ts";
import { type CarryoverDraft, makeCarryoverPlan, nightPercentage, servingPolicy } from "./serving.ts";

export interface GainerInput {
  date: string;
  mode?: GainerMode;
  sweetener?: SweetenerMode;
  targetCaloriesKcal?: number;
}

function project(day: DaySummary, nutrition: Macros) {
  const consumedAfter: MaybeMacros = { ...day.consumed };
  for (const key of macroKeys)
    consumedAfter[key] = day.consumed[key] === null ? null : round(day.consumed[key] + nutrition[key]);
  return { consumedAfter, remainingAfter: difference(day.remaining, nutrition) };
}

function calculateBatch(input: GainerInput, config: GainerConfig, day: DaySummary) {
  const recipe = resolveRecipe(config),
    baseMixNutrition = recipe.baseNutrition;
  validateDate(input.date);
  if (day.date !== input.date)
    throw new CliError(
      "GAINER_DATE_MISMATCH",
      "Summary date does not match the requested date.",
      "Read the requested day again.",
    );
  const mode = input.mode ?? config.defaultMode;
  if (
    input.targetCaloriesKcal !== undefined &&
    (!Number.isFinite(input.targetCaloriesKcal) ||
      input.targetCaloriesKcal < 0 ||
      input.targetCaloriesKcal > 20_000 ||
      mode !== "calories")
  )
    throw new CliError(
      "INVALID_GAINER_TARGET",
      "An explicit target from 0 to 20000 kcal requires mode=calories.",
      "Use fitia_optimal without a target to budget against Fitia.",
    );
  const fitiaAware = mode !== "calories";
  const resolved = !input.sweetener || input.sweetener === "auto" ? config.sweetenerInventory : input.sweetener;
  const ranges = greenRanges(day.goals);
  const context = {
    recipeProfile: {
      activeProfile: recipe.profileId,
      enabledIngredients: recipe.ingredients.map((i) => i.id),
      disabledIngredients: Object.entries(config.recipeProfiles[config.activeProfile]!.ingredients)
        .filter(([, i]) => !i?.enabled)
        .map(([id]) => id),
      effectiveBaseAmounts: Object.fromEntries(
        recipe.ingredients.map((i) => [i.id, { amount: i.amount, unit: i.unit }]),
      ),
      waterMode: recipe.waterMode,
      ...(recipe.anchorWaterRatio && { anchorWaterRatio: recipe.anchorWaterRatio }),
    },
    recipeId: recipe.id,
    date: input.date,
    mode,
    fitia: day,
    configUsed: config,
    greenRanges: ranges,
  };
  const warnings = [...day.warnings];
  const stop = (status: "needs_input" | "not_recommended" | "sweetener_exceeds_target", reason: string) => ({
    ...context,
    status,
    reason,
    warnings,
    baseMix: { scaleFactor: 0 },
    drink: null,
    suggestedMealLog: null,
  });
  if (resolved === "unknown")
    return { ...stop("needs_input", "¿Tienes stevia, miel, ambos o ninguno?"), options: sweetenerModes };
  const configured = gainerRecipe.sweeteners[resolved];
  let honeyG = configured.honeyTablespoons * config.honeyGramsPerTablespoon;
  let sweetNutrition = scaleMacros(config.honeyProfile.per100G, honeyG / 100);
  let practicalSweetNutrition = scaleMacros(config.honeyProfile.per100G, Math.round(honeyG) / 100);
  let sweetener = {
    mode: resolved,
    ...configured,
    honeyTablespoons: Number(configured.honeyTablespoons),
    honeyG,
    practicalHoneyG: Math.round(honeyG),
    ...rounded(sweetNutrition),
    honeyProfile: config.honeyProfile,
  };
  // Preserve the legacy target field; the optimal budget is explicitly reported separately.
  const target = input.targetCaloriesKcal ?? day.remaining.caloriesKcal;
  if (
    target === null ||
    ((fitiaAware || input.targetCaloriesKcal === undefined) && !day.coverage.complete) ||
    (fitiaAware && (!ranges || macroKeys.some((key) => day.remaining[key] === null || day.consumed[key] === null)))
  )
    return {
      ...stop(
        "needs_input",
        "El diario tiene objetivos o consumo incompletos. Revisa los campos desconocidos antes de calcular automáticamente.",
      ),
      sweetener,
    };
  const optimization =
    mode === "fitia_adaptive" && ranges
      ? recipe.adaptive.strategy === "proportional_v2"
        ? optimizeProportionalAdaptive(day.consumed as Macros, ranges, resolved, config, recipe)
        : optimizeAdaptive(
            day.consumed as Macros,
            ranges,
            sweetNutrition,
            practicalSweetNutrition,
            recipe.adaptive,
            recipe,
          )
      : mode === "fitia_optimal" && ranges
        ? optimizeGainer(day.consumed as Macros, ranges, sweetNutrition, practicalSweetNutrition, recipe)
        : undefined;
  const proportional = optimization?.mode === "fitia_adaptive" && "preparation" in optimization ? optimization : null;
  if (proportional?.preparation) {
    const selected = proportionalHoney(proportional.preparation.honeyTablespoons, config);
    honeyG = selected.honeyG;
    sweetNutrition = selected.exact;
    practicalSweetNutrition = selected.practical;
    sweetener = {
      ...sweetener,
      honeyTablespoons: proportional.preparation.honeyTablespoons,
      honeyG,
      practicalHoneyG: selected.practicalHoneyG,
      ...rounded(sweetNutrition),
    };
  }
  const budget = optimization?.maxAdditionalCaloriesKcal ?? target;
  if (optimization?.outcome === "not_needed")
    return { ...stop("not_recommended", optimization.reason), targetCaloriesKcal: target, sweetener, optimization };
  if (budget <= 0)
    return {
      ...stop(
        "not_recommended",
        optimization?.reason ?? "No quedan calorías dentro del objetivo registrado para este cálculo.",
      ),
      targetCaloriesKcal: target,
      sweetener,
      ...(optimization && { optimization }),
    };
  if (!proportional && sweetNutrition.caloriesKcal > budget)
    return {
      ...stop(
        "sweetener_exceeds_target",
        "La miel configurada por sí sola excede el objetivo; no se redujeron sus cucharadas automáticamente.",
      ),
      targetCaloriesKcal: target,
      sweetener,
      ...(optimization && { optimization }),
      excessCaloriesKcal: round(sweetNutrition.caloriesKcal - budget),
      maximumHoneyGWithinTarget:
        config.honeyProfile.per100G.caloriesKcal > 0
          ? round((budget / config.honeyProfile.per100G.caloriesKcal) * 100)
          : null,
    };
  const scale = optimization?.scaleFactor ?? (target - sweetNutrition.caloriesKcal) / baseMixNutrition.caloriesKcal;
  const limitingFactors = optimization?.outcome === "limited_by_calories" ? ["caloriesKcal"] : [];
  const adaptiveAmounts = optimization?.mode === "fitia_adaptive" ? optimization.amounts : null;
  const practicalAmounts = adaptiveAmounts ?? scaledAmounts(scale, recipe);
  const amount = (id: ProfileIngredientId, base: number) => adaptiveAmounts?.[id] ?? base * scale;
  const ingredients = recipe.ingredients.map((i) => ({
    id: i.id,
    name: i.name,
    ...(i.unit === "g"
      ? { exactG: amount(i.id, i.amount), practicalG: quantity(practicalAmounts, i.id) }
      : { exactMl: amount(i.id, i.amount), practicalMl: quantity(practicalAmounts, i.id) }),
  }));
  if (scale <= 0 || !ingredients.some((i) => "practicalG" in i && i.practicalG > 0))
    return {
      ...stop(
        "not_recommended",
        optimization?.reason ?? "No queda una porción de mezcla medible con una balanza de gramos enteros.",
      ),
      targetCaloriesKcal: target,
      sweetener,
      ...(optimization && { optimization }),
    };
  const { exact, practical } = adaptiveAmounts
    ? {
        exact: amountsNutrition(adaptiveAmounts, sweetNutrition, recipe),
        practical: amountsNutrition(adaptiveAmounts, practicalSweetNutrition, recipe),
      }
    : portionNutrition(scale, sweetNutrition, practicalSweetNutrition, recipe);
  if (
    !fitsProfile(practicalAmounts, practical, recipe) ||
    (recipe.profileId !== "legacy_v1" && exact.caloriesKcal > recipe.adaptive.maxBatchCaloriesKcal)
  )
    return {
      ...stop("not_recommended", "La porción solicitada no cumple los límites prácticos del perfil activo."),
      sweetener,
      targetCaloriesKcal: target,
      ...(optimization && { optimization }),
    };
  const waterMl =
    proportional?.adaptive.derivedIngredients?.waterMl ??
    (adaptiveAmounts || recipe.waterMode !== "legacy"
      ? waterForAmounts(practicalAmounts, recipe)
      : recipe.waterMl * scale);
  let pen = 0,
    practicalPen = 0;
  for (const i of recipe.ingredients) {
    if (!i.price) continue;
    pen += (amount(i.id, i.amount) * i.price.pen) / i.price.packageAmount;
    practicalPen += (quantity(practicalAmounts, i.id) * i.price.pen) / i.price.packageAmount;
  }
  const projection = project(day, exact),
    practicalProjection = project(day, practical);
  if (honeyG > 0 && config.honeyProfile.source === "standard_reference")
    warnings.push("La miel usa una referencia estándar, no la etiqueta de tu producto.");
  if (
    optimization
      ? optimization.after.proteinG === "low"
      : day.remaining.proteinG !== null && day.remaining.proteinG > exact.proteinG
  )
    warnings.push("El batido no cubre toda la proteína pendiente; no es un suplemento específicamente proteico.");
  if (input.targetCaloriesKcal !== undefined && !day.coverage.complete)
    warnings.push("Cálculo por objetivo explícito; la proyección de Fitia puede estar incompleta.");
  if (
    mode === "calories" &&
    macroKeys.some(
      (key) => key !== "proteinG" && projection.remainingAfter[key] !== null && projection.remainingAfter[key]! < -0.01,
    )
  )
    warnings.push("El objetivo explícito/calórico excede algún objetivo de Fitia; revisa la proyección.");
  if (mode === "calories" && practical.caloriesKcal > target + 0.01)
    warnings.push(
      "El redondeo doméstico supera ligeramente un límite; registra la nutrición práctica si preparas las cantidades enteras.",
    );
  if (optimization?.leftGreen.length)
    warnings.push(
      `El compromiso saca del rango verde: ${optimization.leftGreen.join(", ")}. Revisa la proyección práctica.`,
    );
  if (optimization && macroKeys.some((key) => optimization.after[key] === "high"))
    warnings.push(
      "Quedan macros por encima del rango verde; el resultado incluye su penalización y no intenta aumentarlos como objetivo.",
    );
  const status = optimization?.outcome === "all_green" ? "recommended" : "acceptable";
  return {
    ...context,
    status,
    reason:
      optimization?.reason ?? "Porción calculada para el objetivo calórico indicado; revisa el impacto en los macros.",
    ...(optimization && { optimization }),
    scoringComponents: optimization
      ? {
          nutritionScore:
            optimization.mode === "fitia_adaptive" ? optimization.score.nutritionAfter : optimization.score.after,
          deviationPenalty: optimization.mode === "fitia_adaptive" ? optimization.adaptive.deviationPenalty : 0,
          costPenalty: 0,
          practicalityPenalty: 0,
        }
      : null,
    targetCaloriesKcal: target,
    sweetener,
    baseMix: {
      scaleFactor: scale,
      ...(adaptiveAmounts && { proportions: "adaptive", scaleFactorBasis: "calorie_equivalent_only" }),
      availableCaloriesKcal: round(budget - sweetNutrition.caloriesKcal),
      caloriesKcal: round(baseMixNutrition.caloriesKcal * scale),
      limitingFactors,
    },
    ingredients,
    water: { exactMl: waterMl, practicalMl: Math.round(waterMl / 10) * 10 },
    creatineG: recipe.creatineG,
    nutrition: exact,
    practicalNutrition: practical,
    cost: {
      pen: round(pen),
      practicalPen: round(practicalPen),
      totalPen: null,
      scope: "base_mix_subtotal",
      excluded: [
        "honey",
        "stevia",
        "creatine",
        "water_ice",
        ...recipe.ingredients.filter((i) => !i.price).map((i) => i.id),
      ],
    },
    nutritionAssumptions: [
      "Cinnamon and vanilla nutrition excluded: no supplied labels.",
      "Stevia and creatine modeled as zero kcal/macros.",
    ],
    projection,
    practicalProjection,
    warnings,
    suggestedMealLog: {
      date: input.date,
      name: `${recipe.name}${adaptiveAmounts ? " adaptive" : ""} (${resolved}, rounded serving)`,
      ...practical,
      confirm: false,
    },
    exactMealLog: {
      date: input.date,
      name: `${recipe.name}${adaptiveAmounts ? " adaptive" : ""} (${resolved}, exact serving)`,
      ...exact,
      confirm: false,
    },
    mealLogBasis: "suggestedMealLog uses practical quantities; select the meal and confirm only after user approval.",
  };
}

function calculateServing(input: GainerInput, config: GainerConfig, day: DaySummary) {
  const result = calculateBatch(input, config, day);
  if (!("practicalNutrition" in result)) return result;
  if (result.mode === "calories" || result.practicalNutrition.caloriesKcal <= config.maxNightCaloriesKcal)
    return { ...result, servingStrategy: "single_serving" as const };
  const draft: CarryoverDraft = {
    sourceDate: input.date,
    recipeId: result.recipeId,
    scaleFactor: result.baseMix.scaleFactor,
    sweetener: result.sweetener.mode,
    nightPercent: nightPercentage(result.practicalNutrition, config, day),
    ...(result.optimization?.mode === "fitia_adaptive" && result.optimization.amounts
      ? { adaptiveAmounts: result.optimization.amounts }
      : {}),
    ...(result.optimization?.mode === "fitia_adaptive" &&
    "preparation" in result.optimization &&
    result.optimization.preparation
      ? { adaptivePreparation: result.optimization.preparation }
      : {}),
  };
  const plan = makeCarryoverPlan(draft, config);
  const nightProjection = project(day, plan.nightPortion.nutrition);
  const nightStates = Object.fromEntries(
    macroKeys.map((key) => {
      const value = nightProjection.consumedAfter[key],
        range = result.greenRanges?.[key];
      return [
        key,
        value === null || !range ? "unknown" : value < range.min ? "low" : value > range.max ? "high" : "green",
      ];
    }),
  );
  return {
    ...result,
    servingStrategy: "split_next_morning" as const,
    fullBatch: { ...plan.fullBatch, nutrition: result.nutrition, cost: result.cost },
    nightPortion: plan.nightPortion,
    morningCarryover: plan.morningCarryover,
    nightProjection,
    nightOptimization: { after: nightStates },
    servingReason:
      "El lote óptimo supera el límite nocturno. Toma la fracción indicada esta noche y reserva el resto para mañana; el resultado del lote completo no se atribuye íntegramente a hoy.",
    nightMealLog: plan.nightMealLog,
    morningCarryoverMealLog: plan.morningCarryoverMealLog,
    suggestedMealLog: plan.nightMealLog,
    exactMealLog: null,
    carryoverDraft: draft,
    carryoverId: plan.id,
    carryoverPersistence: "not_saved" as const,
    servingPolicy: {
      ...servingPolicy,
      preferredNightCaloriesKcal: config.preferredNightCaloriesKcal,
      maxNightCaloriesKcal: config.maxNightCaloriesKcal,
    },
    preparation: [
      "Prepara el lote completo con los ingredientes prácticos indicados.",
      "Licúa completamente y pesa el lote terminado; divide por los porcentajes indicados después de mezclar.",
      "Consume la fracción nocturna y refrigera de inmediato el resto para la mañana siguiente.",
      "La creatina ya está en el lote y se reparte entre ambas tomas; no añadas otra dosis por porción.",
    ],
    mealLogBasis:
      "suggestedMealLog and nightMealLog contain only the night fraction. Save the carryover explicitly, then log each fraction on its actual consumption date using its separate payload and preview/confirmation.",
  };
}

// All projections share the same verified attribution. Fitia's original summary
// is never used as mutable planning state, including on repeated calculations.
export function calculateGainer(
  input: GainerInput,
  config: GainerConfig,
  day: DaySummary,
  carryover: CarryoverContext = carryoverContext([], day, null, ""),
) {
  const plannedDay = planningDay(day, carryover);
  const optimal = (input.mode ?? config.defaultMode) !== "calories";
  const result = calculateServing(input, config, optimal ? plannedDay : day);
  const fullNutrition = "practicalNutrition" in result ? result.practicalNutrition : emptyMacros();
  const todayNutrition = "nightPortion" in result ? result.nightPortion.nutrition : fullNutrition;
  const sourceDates = [
    ...new Set(
      carryover.items.filter((i) => "excludedFromPlanning" in i && i.excludedFromPlanning).map((i) => i.sourceDate),
    ),
  ].sort();
  return {
    ...result,
    fitia: day,
    // Retain the historical field as the real Fitia calorie gap; optimal sizing
    // uses planningConsumed and optimization.maxAdditionalCaloriesKcal instead.
    targetCaloriesKcal: input.targetCaloriesKcal ?? day.remaining.caloriesKcal,
    registeredConsumed: carryover.registeredConsumed,
    planningConsumed: carryover.planningConsumed,
    excludedCarryoverFromPlanning: carryover.excludedCarryoverFromPlanning,
    effectiveProjection: project(plannedDay, fullNutrition),
    fitiaProjection: project(day, todayNutrition),
    planningBasis: `Registered Fitia totals include ${carryover.excludedCarryoverFromPlanning.caloriesKcal} kcal from verified carryovers with earlier source dates${sourceDates.length ? ` (${sourceDates.join(", ")})` : ""}. These are excluded from the ${day.date} planning budget. Unregistered pending portions reserve ${carryover.plannedNutrition.caloriesKcal} kcal once. ${optimal ? `${input.mode ?? config.defaultMode} uses planningConsumed.` : "calories mode retains its explicit target or real Fitia calorie gap; planningConsumed is context only."}`,
    projectionScope: `projection/practicalProjection describe the full exact/practical batch on the ${optimal ? "planning" : "registered Fitia"} basis; nightProjection uses that same basis for only tonight. effectiveProjection attributes the full practical batch to its source date using planningConsumed. fitiaProjection adds only today's practical serving (the night fraction for a split) to registeredConsumed; it excludes unregistered pending portions.`,
    ...(carryover.items.length ? { carryover } : {}),
  };
}

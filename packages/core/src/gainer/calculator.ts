import { validateDate } from "../diary.ts";
import { CliError } from "../errors.ts";
import { type DaySummary, difference, type Macros, type MaybeMacros, macroKeys, round } from "../nutrition.ts";
import { greenRanges, optimizeGainer } from "./optimization.ts";
import { portionNutrition, roundedMacros as rounded, scaleMacros } from "./portion.ts";
import {
  baseMixNutrition,
  type GainerConfig,
  type GainerMode,
  gainerRecipe,
  type SweetenerMode,
  sweetenerModes,
} from "./recipe.ts";
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
  const resolved = !input.sweetener || input.sweetener === "auto" ? config.sweetenerInventory : input.sweetener;
  const ranges = greenRanges(day.goals);
  const context = {
    recipeId: gainerRecipe.id,
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
  const honeyG = configured.honeyTablespoons * config.honeyGramsPerTablespoon;
  const sweetNutrition = scaleMacros(config.honeyProfile.per100G, honeyG / 100);
  const practicalSweetNutrition = scaleMacros(config.honeyProfile.per100G, Math.round(honeyG) / 100);
  const sweetener = {
    mode: resolved,
    ...configured,
    honeyG,
    practicalHoneyG: Math.round(honeyG),
    ...rounded(sweetNutrition),
    honeyProfile: config.honeyProfile,
  };
  // Preserve the legacy target field; the optimal budget is explicitly reported separately.
  const target = input.targetCaloriesKcal ?? day.remaining.caloriesKcal;
  if (
    target === null ||
    ((mode === "fitia_optimal" || input.targetCaloriesKcal === undefined) && !day.coverage.complete) ||
    (mode === "fitia_optimal" &&
      (!ranges || macroKeys.some((key) => day.remaining[key] === null || day.consumed[key] === null)))
  )
    return {
      ...stop(
        "needs_input",
        "El diario tiene objetivos o consumo incompletos. Revisa los campos desconocidos antes de calcular automáticamente.",
      ),
      sweetener,
    };
  const optimization =
    mode === "fitia_optimal" && ranges
      ? optimizeGainer(day.consumed as Macros, ranges, sweetNutrition, practicalSweetNutrition)
      : undefined;
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
  if (sweetNutrition.caloriesKcal > budget)
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
  const ingredients = gainerRecipe.ingredients.map((i) => ({
    id: i.id,
    name: i.name,
    ...(i.unit === "g"
      ? { exactG: i.amount * scale, practicalG: Math.round(i.amount * scale) }
      : { exactMl: i.amount * scale, practicalMl: Math.round(i.amount * scale) }),
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
  const { exact, practical } = portionNutrition(scale, sweetNutrition, practicalSweetNutrition);
  let pen = 0,
    practicalPen = 0;
  for (const i of gainerRecipe.ingredients) {
    pen += (i.amount * scale * i.price.pen) / i.price.packageAmount;
    practicalPen += (Math.round(i.amount * scale) * i.price.pen) / i.price.packageAmount;
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
    targetCaloriesKcal: target,
    sweetener,
    baseMix: {
      scaleFactor: scale,
      availableCaloriesKcal: round(budget - sweetNutrition.caloriesKcal),
      caloriesKcal: round(baseMixNutrition.caloriesKcal * scale),
      limitingFactors,
    },
    ingredients,
    water: { exactMl: gainerRecipe.waterMl * scale, practicalMl: Math.round((gainerRecipe.waterMl * scale) / 10) * 10 },
    creatineG: gainerRecipe.creatineG,
    nutrition: exact,
    practicalNutrition: practical,
    cost: {
      pen: round(pen),
      practicalPen: round(practicalPen),
      totalPen: null,
      scope: "base_mix_subtotal",
      excluded: ["honey", "stevia", "creatine", "water_ice"],
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
      name: `${gainerRecipe.name} (${resolved}, rounded serving)`,
      ...practical,
      confirm: false,
    },
    exactMealLog: {
      date: input.date,
      name: `${gainerRecipe.name} (${resolved}, exact serving)`,
      ...exact,
      confirm: false,
    },
    mealLogBasis: "suggestedMealLog uses practical quantities; select the meal and confirm only after user approval.",
  };
}

export function calculateGainer(input: GainerInput, config: GainerConfig, day: DaySummary) {
  const result = calculateBatch(input, config, day);
  if (!("practicalNutrition" in result)) return result;
  if (result.mode !== "fitia_optimal" || result.practicalNutrition.caloriesKcal <= config.maxNightCaloriesKcal)
    return { ...result, servingStrategy: "single_serving" as const };
  const draft: CarryoverDraft = {
    sourceDate: input.date,
    recipeId: gainerRecipe.id,
    scaleFactor: result.baseMix.scaleFactor,
    sweetener: result.sweetener.mode,
    nightPercent: nightPercentage(result.practicalNutrition, config, day),
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
    projectionScope:
      "optimization.after and legacy projections describe the full batch hypothetically on the source day; nightProjection describes only tonight.",
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

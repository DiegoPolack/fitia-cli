import { invalidResponse, object, optionalString, requiredString } from "./errors.ts";

const nutrientNames = [
  "added_sugars",
  "alcohol",
  "alcohol_calculated",
  "caffeine",
  "calcium",
  "calories",
  "carbs",
  "cholesterol",
  "copper",
  "fat",
  "fiber",
  "folate",
  "iron",
  "magnesium",
  "manganese",
  "omega3",
  "omega6",
  "phosphorus",
  "potassium",
  "protein",
  "salt",
  "sat_fat",
  "selenium",
  "sodium",
  "sugars",
  "trans_fat",
  "vitamin_a",
  "vitamin_b1",
  "vitamin_b12",
  "vitamin_b2",
  "vitamin_b3",
  "vitamin_b5",
  "vitamin_b6",
  "vitamin_c",
  "vitamin_d",
  "vitamin_e",
  "vitamin_k",
  "water",
  "zinc",
];

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalidResponse();
  return value;
}

export function searchFoodsResponse(input: unknown, query: string, country: string, language: string, limit: number) {
  const data = object(input);
  if (!Array.isArray(data.hits) || data.hits.length > 50) invalidResponse();
  const foods = data.hits.slice(0, limit).map((hit) => {
    const source = object(object(hit)._source);
    const recipe = source.collection === "recipe";
    const rawNutrients = object(recipe ? source.macros_per_serving : source.nutrients);
    const values: Record<string, { amount: number; unit: string }> = {};
    for (const name of recipe ? ["calories", "protein", "carbs", "fat", "net_carbs"] : nutrientNames) {
      if (rawNutrients[name] == null) continue;
      if (recipe) {
        values[name] = { amount: amount(rawNutrients[name]), unit: name === "calories" ? "kcal" : "g" };
        continue;
      }
      const nutrient = object(rawNutrients[name]);
      values[name] = { amount: amount(nutrient.size), unit: requiredString(nutrient.unit) };
    }
    if (!Array.isArray(source.servings)) invalidResponse();
    const metricUnits = new Set<string>();
    const servings = source.servings.map((raw) => {
      const serving = object(raw);
      const size = amount(serving.size),
        unit = requiredString(serving.unit);
      if (serving.default === true && size === 1 && (unit === "g" || unit === "ml")) metricUnits.add(unit);
      // Some live records contain a zero-sized placeholder, not a usable portion.
      return {
        name: requiredString(serving.name),
        size: size === 0 ? null : size,
        unit,
        quantity: requiredString(serving.quantity),
      };
    });
    const metric = metricUnits.size === 1 ? [...metricUnits][0] : null;
    const basis = recipe
      ? "per-serving"
      : metric === "g"
        ? "per-gram"
        : metric === "ml"
          ? "per-milliliter"
          : "unverified";
    const scale = (name: string, expectedUnit: string, factor: number) => {
      const nutrient = values[name];
      if (!nutrient || nutrient.unit !== expectedUnit) return null;
      const scaled = nutrient.amount * factor;
      if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER / 1e6) invalidResponse();
      return Math.round(scaled * 1e6) / 1e6;
    };
    const macros = (factor: number) => ({
      caloriesKcal: scale("calories", "kcal", factor),
      proteinG: scale("protein", "g", factor),
      carbsG: scale("carbs", "g", factor),
      fatG: scale("fat", "g", factor),
    });
    const complete = (value: ReturnType<typeof macros>) => Object.values(value).every((amount) => amount !== null);
    const entry = (serving: (typeof servings)[number], values: ReturnType<typeof macros>) => ({
      serving,
      entry: {
        name: `${requiredString(source.name)}, ${serving.quantity} ${serving.name} (${serving.size} ${serving.unit})`,
        caloriesKcal: values.caloriesKcal!,
        proteinG: values.proteinG!,
        carbsG: values.carbsG!,
        fatG: values.fatG!,
      },
    });
    const quickEntries = recipe
      ? (() => {
          const candidates = servings.filter(
            (value) =>
              value.size !== null &&
              value.quantity === "1" &&
              !/^(?:g|gr|gramo?s?|grams?|kg|kilogramos?|ml|mililitros?|milliliters?|l|litros?|liters?|oz|onza?s?|ounces?)$/i.test(
                value.name,
              ),
          );
          const serving = candidates.length === 1 ? candidates[0] : undefined;
          const values = macros(1);
          return serving && complete(values) ? [entry(serving, values)] : [];
        })()
      : servings.flatMap((serving) => {
          if (serving.size === null || serving.unit !== metric) return [];
          const values = macros(serving.size);
          return complete(values) ? [entry(serving, values)] : [];
        });
    return {
      id: requiredString(source.object_id),
      name: requiredString(source.name),
      brand: source.brand == null ? null : optionalString(object(source.brand).name),
      source: requiredString(source.source),
      reference: { collection: requiredString(source.collection), subcollection: requiredString(source.subcollection) },
      cookingState: optionalString(source.cooking_state),
      servings,
      nutrition: {
        basis,
        values,
        per100: !recipe && metric ? macros(100) : null,
        perServing: recipe ? macros(1) : null,
      },
      quickEntries,
    };
  });
  return {
    scope: "food-database",
    query,
    country,
    language,
    limit,
    count: foods.length,
    foods,
    limitations: [
      "Results may include foods and recipes. No pagination or full database result count is available.",
      "Food nutrient basis is derived from a default 1 g or 1 ml serving. Unknown bases are not scaled.",
      "Recipe macros use the provider's explicit per-serving values, not a weight-based conversion.",
      "quickEntries includes only servings with complete, unambiguous calorie and macro totals.",
      "Zero-sized provider servings have size null because their amount is unknown.",
      "Values use the listed cooking state. No serving or raw/cooked conversion is performed.",
      "Search only. No meals are logged or changed.",
    ],
  };
}

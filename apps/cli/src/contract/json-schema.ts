export type JsonSchema = Record<string, unknown>;

export const stringSchema = { type: "string" };
export const integerSchema = { type: "integer" };
export const booleanSchema = { type: "boolean" };
export const nullableStringSchema = { type: ["string", "null"] };
export const nonnegativeNumberSchema = { type: "number", minimum: 0 };
export const nullableMeasureSchema = { type: ["number", "null"], minimum: 0 };
export const signedMeasureSchema = { type: ["number", "null"] };

export const array = (items: JsonSchema) => ({ type: "array", items });
export const object = (properties: Record<string, JsonSchema>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const stringsSchema = array(stringSchema);
export const totalsSchema = object({
  caloriesKcal: nonnegativeNumberSchema,
  proteinG: nonnegativeNumberSchema,
  carbsG: nonnegativeNumberSchema,
  fatG: nonnegativeNumberSchema,
});
export const maybeTotalsSchema = object({
  caloriesKcal: nullableMeasureSchema,
  proteinG: nullableMeasureSchema,
  carbsG: nullableMeasureSchema,
  fatG: nullableMeasureSchema,
});
export const remainingSchema = object({
  caloriesKcal: signedMeasureSchema,
  proteinG: signedMeasureSchema,
  carbsG: signedMeasureSchema,
  fatG: signedMeasureSchema,
});
export const entrySchema = object({
  name: stringSchema,
  caloriesKcal: nonnegativeNumberSchema,
  proteinG: nonnegativeNumberSchema,
  carbsG: nonnegativeNumberSchema,
  fatG: nonnegativeNumberSchema,
});

export const daySummarySchema = object({
  date: stringSchema,
  updateTime: stringSchema,
  goals: maybeTotalsSchema,
  consumed: maybeTotalsSchema,
  remaining: remainingSchema,
  knownConsumed: totalsSchema,
  meals: array(
    object({
      id: stringSchema,
      name: stringSchema,
      goals: maybeTotalsSchema,
      consumed: maybeTotalsSchema,
      knownConsumed: totalsSchema,
      remaining: remainingSchema,
    }),
  ),
  coverage: object({
    complete: booleanSchema,
    eatenEntries: integerSchema,
    plannedEntries: integerSchema,
    unknownStateEntries: integerSchema,
    unknownEntries: array(
      object({ mealId: stringSchema, itemId: stringSchema, name: stringSchema, reason: stringSchema }),
    ),
    calorieCheck: { enum: ["matches", "mismatch", "unavailable"] },
    cachedNutrientsStatus: { enum: ["absent", "unverified", "matches", "stale"] },
  }),
  warnings: stringsSchema,
});

const macroValuesSchema = {
  anyOf: [
    object({
      caloriesKcal: nullableMeasureSchema,
      proteinG: nullableMeasureSchema,
      carbsG: nullableMeasureSchema,
      fatG: nullableMeasureSchema,
    }),
    { type: "null" },
  ],
};

export const foodResultSchema = object({
  id: stringSchema,
  name: stringSchema,
  brand: nullableStringSchema,
  source: stringSchema,
  reference: object({ collection: stringSchema, subcollection: stringSchema }),
  cookingState: nullableStringSchema,
  servings: array(
    object({
      name: stringSchema,
      size: { type: ["number", "null"], exclusiveMinimum: 0 },
      unit: stringSchema,
      quantity: stringSchema,
    }),
  ),
  nutrition: object({
    basis: { enum: ["per-gram", "per-milliliter", "per-serving", "unverified"] },
    values: { type: "object", additionalProperties: object({ amount: nonnegativeNumberSchema, unit: stringSchema }) },
    per100: macroValuesSchema,
    perServing: macroValuesSchema,
  }),
  quickEntries: array(
    object({
      serving: object({
        name: stringSchema,
        size: { type: "number", exclusiveMinimum: 0 },
        unit: stringSchema,
        quantity: stringSchema,
      }),
      entry: entrySchema,
    }),
  ),
});

export const mealSuggestionsSchema = object({
  date: stringSchema,
  meal: stringSchema,
  source: { const: "fitia-planner" },
  readOnly: { const: true },
  status: { enum: ["ok", "incomplete-diary", "no-budget", "no-matches", "dietary-review-required"] },
  day: daySummarySchema,
  budget: { anyOf: [totalsSchema, { type: "null" }] },
  budgetRule: stringSchema,
  rankingRule: stringSchema,
  selectedFoodIds: array(integerSchema),
  language: nullableStringSchema,
  returnedCount: integerSchema,
  excludedCount: integerSchema,
  suggestions: array(
    object({
      rank: integerSchema,
      providerIndex: integerSchema,
      foods: array(
        object({
          id: stringSchema,
          name: stringSchema,
          portion: object({
            size: { type: "number", exclusiveMinimum: 0 },
            unit: { enum: ["g", "ml"] },
            cookingState: stringSchema,
          }),
          nutrition: totalsSchema,
          preparationNotes: stringsSchema,
          entry: entrySchema,
        }),
      ),
      totals: totalsSchema,
      remainingAfter: remainingSchema,
      tradeoffs: stringsSchema,
    }),
  ),
  warnings: stringsSchema,
});

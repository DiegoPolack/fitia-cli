import type { Entry, MealName } from "./diary.ts";
import { CliError, invalidResponse, object, requiredString } from "./errors.ts";
import { amount, type DaySummary, difference, emptyMacros, type Macros, macroKeys, round } from "./nutrition.ts";

export type SuggestInput = { date: string; meal: MealName; limit: number; foods?: number[] };
export type FoodSuggestionRequest = {
  dietType: string;
  minCalories: number;
  maxCalories: number;
  targetCalories: number;
  targetProteins: number;
  targetCarbs: number;
  targetFats: number;
  mealType: string;
  selectedFoods: number[];
  measurementSystem: "metric";
  country: string;
  language: string;
  creationDate: string;
  userID: string;
};
export const plannerMeals = {
  breakfast: { type: "breakfast", field: "availableBreakfastPlannerFoods" },
  "snack-1": { type: "mid_morning", field: "availableMidMorningPlannerFoods" },
  lunch: { type: "lunch", field: "availableLunchPlannerFoods" },
  "snack-2": { type: "mid_afternoon", field: "availableMidAfternoonPlannerFoods" },
  dinner: { type: "dinner", field: "availableDinnerPlannerFoods" },
} as const;
export function validateSuggestion(input: SuggestInput) {
  if (!Object.hasOwn(plannerMeals, input.meal))
    throw new CliError(
      "INVALID_MEAL",
      "Choose a meal for suggestions.",
      "Use breakfast, snack-1, lunch, snack-2, or dinner.",
    );
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10)
    throw new CliError("INVALID_ARGUMENT", "Suggestion limit must be from 1 to 10.", "Use --limit 5.");
  if (
    input.foods !== undefined &&
    (!input.foods.length ||
      input.foods.length > 100 ||
      input.foods.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 999999) ||
      new Set(input.foods).size !== input.foods.length)
  )
    throw new CliError(
      "INVALID_FOODS",
      "Supply up to 100 unique planner food IDs.",
      "Use --foods 1,4 to narrow your saved Fitia food choices.",
    );
}
export function suggestionBudget(day: DaySummary, meal: MealName): Macros | null {
  const selected = day.meals.filter((m) => m.name === meal);
  if (selected.length !== 1)
    throw new CliError(
      "MEAL_NOT_FOUND",
      "The diary does not have exactly one matching meal.",
      "Choose a meal shown by day summary. No meal will be created.",
      4,
    );
  if (
    !day.coverage.complete ||
    macroKeys.some((key) => day.remaining[key] === null) ||
    selected[0]!.remaining.caloriesKcal === null
  )
    return null;
  const remaining = day.remaining as Macros;
  const calories = Math.max(0, Math.floor(Math.min(remaining.caloriesKcal, selected[0]!.remaining.caloriesKcal!)));
  const proportion = remaining.caloriesKcal > 0 ? calories / remaining.caloriesKcal : 0;
  return {
    caloriesKcal: calories,
    proteinG: Math.floor(Math.max(0, remaining.proteinG) * proportion),
    carbsG: Math.floor(Math.max(0, remaining.carbsG) * proportion),
    fatG: Math.floor(Math.max(0, remaining.fatG) * proportion),
  };
}
export function suggestionRequest(
  preferences: Record<string, any>,
  uid: string,
  input: SuggestInput,
  budget: Macros,
): FoodSuggestionRequest {
  const stored = preferences[plannerMeals[input.meal].field];
  if (
    !Array.isArray(stored) ||
    !stored.length ||
    stored.length > 500 ||
    stored.some((id) => !/^\d{1,6}$/.test(String(id)) || Number(id) < 1)
  )
    throw new CliError(
      "SUGGESTION_PREFERENCES_UNAVAILABLE",
      "No verified planner food choices are saved for this meal.",
      "Set food choices in Fitia, or use food search for specific foods.",
      4,
    );
  const available = [...new Set(stored.map(Number))];
  if (input.foods?.some((id) => !available.includes(id)))
    throw new CliError(
      "FOOD_NOT_SELECTED",
      "One of the requested foods is not in your saved choices for this meal.",
      "The --foods option can only narrow your Fitia meal preferences.",
    );
  const country = preferences.pais,
    language = preferences.databaseLanguage;
  if (
    typeof country !== "string" ||
    !/^[a-z]{2}$/i.test(country) ||
    typeof language !== "string" ||
    !/^(es|en)$/i.test(language) ||
    typeof preferences.fechaCreacion !== "string" ||
    !Number.isFinite(Date.parse(preferences.fechaCreacion))
  )
    throw new CliError(
      "SUGGESTION_PREFERENCES_UNAVAILABLE",
      "The planner's country, language or account creation date is unavailable.",
      "Check your Fitia profile. No values were invented.",
      4,
    );
  const diet = requiredString(preferences.tipoDieta);
  if (diet.length > 100 || /[\x00-\x1f\x7f]/.test(diet)) invalidResponse();
  return {
    dietType: diet,
    minCalories: Math.floor(budget.caloriesKcal * 0.7),
    maxCalories: budget.caloriesKcal,
    targetCalories: budget.caloriesKcal,
    targetProteins: budget.proteinG,
    targetCarbs: budget.carbsG,
    targetFats: budget.fatG,
    mealType: plannerMeals[input.meal].type,
    selectedFoods: input.foods ?? available,
    measurementSystem: "metric",
    country: country.toUpperCase(),
    language: language.toUpperCase(),
    creationDate: preferences.fechaCreacion,
    userID: uid,
  };
}
export function needsDietaryReview(preferences: Record<string, any>) {
  // This endpoint has no verified allergy/restriction input. Saved food IDs are
  // preferences, not proof that every returned ingredient is safe for a person.
  const restrictions = preferences.restrictionsAndMealPreferences;
  if (!restrictions || typeof restrictions !== "object" || Array.isArray(restrictions)) return true;
  return (
    [restrictions.allergies, restrictions.medicalConditions].some(
      (value) => !Array.isArray(value) || value.length > 0,
    ) || preferences.vegano !== false
  );
}
function text(value: unknown, max = 1000) {
  const s = requiredString(value);
  if (!s.trim() || s.length > max || /[\x00-\x1f\x7f]/.test(s)) invalidResponse();
  return s;
}
function localized(list: unknown, language: string) {
  if (!Array.isArray(list) || list.length > 30) invalidResponse();
  return list.map(object).find((v) => typeof v.language === "string" && v.language.toUpperCase() === language);
}
function suggestedFood(raw: unknown, language: string) {
  const food = object(raw),
    id = text(food.firestoreDocId, 100);
  const local = localized(food.name, language);
  if (!local) invalidResponse();
  const name = text(local.tropicalizedName || local.name, 150);
  if (!Array.isArray(food.servingSettings)) invalidResponse();
  const settings = food.servingSettings.map(object).filter((s) => s.system === "metric");
  if (
    settings.length !== 1 ||
    !["g", "ml"].includes(String(settings[0]!.servingUnit)) ||
    !(amount(settings[0]!.servingSize)! > 0)
  )
    invalidResponse();
  const size = amount(food.selectedSize);
  if (size === null || size <= 0 || size > 5000 || (food.energyUnit !== undefined && food.energyUnit !== "kcal"))
    invalidResponse();
  const unit = settings[0]!.servingUnit as string,
    cookingState = text(food.cookingState, 50);
  const nutrition = emptyMacros();
  ["caloriesPerGram", "proteinPerGram", "carbsPerGram", "fatPerGram"].forEach((key, i) => {
    const value = amount(food[key]);
    if (value === null) invalidResponse();
    nutrition[macroKeys[i]!] = round(value * size);
    if (nutrition[macroKeys[i]!] > (i === 0 ? 20000 : 5000)) invalidResponse();
  });
  const notes = localized(food.recommendations ?? [], language)?.recommendation ?? [];
  if (!Array.isArray(notes) || notes.length > 20) invalidResponse();
  const entry: Entry = { name: `${name}, ${round(size)} ${unit} (${cookingState})`, ...nutrition };
  if (entry.name.length > 200) invalidResponse();
  return {
    id,
    name,
    portion: { size, unit, cookingState },
    nutrition,
    preparationNotes: notes.map((v) => text(v)),
    entry,
  };
}
export function rankSuggestions(raw: unknown, request: FoodSuggestionRequest, day: DaySummary, limit: number) {
  if (!Array.isArray(raw) || raw.length > 100) invalidResponse();
  const seen = new Set<string>();
  let excludedCount = 0;
  const candidates = raw.flatMap((group, providerIndex) => {
    if (!Array.isArray(group) || group.length > 20) invalidResponse();
    if (!group.length) {
      excludedCount++;
      return [];
    }
    const foods = group.map((f) => suggestedFood(f, request.language));
    const totals = emptyMacros();
    for (const food of foods) for (const key of macroKeys) totals[key] += food.nutrition[key];
    macroKeys.forEach((key) => {
      totals[key] = round(totals[key]);
    });
    const fingerprint = JSON.stringify(
      foods.map((food) => [food.id, food.portion.size, food.portion.unit, food.portion.cookingState]).sort(),
    );
    if (
      seen.has(fingerprint) ||
      foods.some((food) => !request.selectedFoods.map(String).includes(food.id)) ||
      totals.caloriesKcal < request.minCalories - 0.01 ||
      totals.caloriesKcal > request.maxCalories + 0.01
    ) {
      excludedCount++;
      return [];
    }
    seen.add(fingerprint);
    const remainingAfter = difference(day.remaining, totals);
    const addedExcess = macroKeys
      .slice(1)
      .reduce(
        (sum, key) => sum + Math.max(0, totals[key] - Math.max(0, day.remaining[key]!)) / Math.max(1, day.goals[key]!),
        0,
      );
    const distance =
      macroKeys
        .slice(1)
        .reduce((sum, key) => sum + Math.max(0, remainingAfter[key]!) / Math.max(1, day.goals[key]!), 0) +
      (request.maxCalories - totals.caloriesKcal) / request.maxCalories;
    const labels = { caloriesKcal: "Calories", proteinG: "Protein", carbsG: "Carbs", fatG: "Fat" };
    const tradeoffs = macroKeys
      .filter((key) => remainingAfter[key]! < -0.01)
      .map(
        (key) =>
          `${labels[key]}: ${Math.round(-remainingAfter[key]! * 100) / 100} ${key === "caloriesKcal" ? "kcal" : "g"} over the daily goal after this option${day.remaining[key]! < 0 ? " (already over before this option)" : ""}.`,
      );
    return [{ providerIndex, foods, totals, remainingAfter, tradeoffs, addedExcess, distance }];
  });
  candidates.sort(
    (a, b) => a.addedExcess - b.addedExcess || a.distance - b.distance || a.providerIndex - b.providerIndex,
  );
  return {
    returnedCount: raw.length,
    excludedCount,
    suggestions: candidates
      .slice(0, limit)
      .map(({ addedExcess, distance, ...candidate }, i) => ({ rank: i + 1, ...candidate })),
  };
}

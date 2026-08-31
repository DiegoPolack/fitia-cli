import { createHash } from "node:crypto";
import { type Fetch, FitiaClient } from "./api.ts";
import { CliError, invalidResponse } from "./errors.ts";
import {
  type FirestoreDocument as Document,
  encodeFields as encode,
  type FirestoreFields as Fields,
  FirestoreDiaryAdapter,
  diaryItemField as itemField,
  mapValue as map,
  numberValue as number,
  stringValue as string,
  timestampValue as timestamp,
} from "./firestore-diary.ts";
import { decodeFields, summarizeDay } from "./nutrition.ts";
import { SafeWriteCoordinator, stateDirectory } from "./safe-write.ts";
import {
  needsDietaryReview,
  plannerMeals,
  rankSuggestions,
  type SuggestInput,
  suggestionBudget,
  suggestionRequest,
  validateSuggestion,
} from "./suggestions.ts";

export const mealTypes = { breakfast: 0, "snack-1": 1, lunch: 2, "snack-2": 3, dinner: 4 } as const;
export type MealName = keyof typeof mealTypes;
export type Entry = { name: string; caloriesKcal: number; proteinG: number; carbsG: number; fatG: number };
export type LogInput = Entry & {
  date: string;
  meal: MealName;
  idempotencyKey?: string;
  occurrence?: number;
  dryRun: boolean;
  yes: boolean;
};
export type RefreshInput = { date: string; dryRun: boolean; yes: boolean };
export type RemoveInput = RefreshInput & { meal: MealName; itemId: string };
export { stateDirectory } from "./safe-write.ts";

export function validateDate(date: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date < "2000-01-01" ||
    date > "2100-12-31" ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new CliError(
      "INVALID_DATE",
      "Expected a real calendar date from 2000 through 2100.",
      "Use --date YYYY-MM-DD in your local calendar.",
    );
  return date.split("-").reverse().join("-");
}

export function validateLog(input: LogInput) {
  validateDate(input.date);
  if (!Object.hasOwn(mealTypes, input.meal))
    throw new CliError("INVALID_MEAL", "Unknown meal.", `Use ${Object.keys(mealTypes).join(", ")}.`);
  if (!input.name?.trim() || input.name.length > 200 || /[\x00-\x1f\x7f]/.test(input.name))
    throw new CliError(
      "INVALID_ENTRY",
      "Supply a food name and serving description from 1 to 200 characters.",
      "For example, --name 'Pan con palta, 1 sandwich'.",
    );
  for (const key of ["caloriesKcal", "proteinG", "carbsG", "fatG"] as const) {
    const amount = input[key];
    if (!Number.isFinite(amount) || amount < 0 || amount > (key === "caloriesKcal" ? 20000 : 5000))
      throw new CliError(
        "INVALID_AMOUNT",
        `Invalid ${key}.`,
        "Supply explicit nonnegative numeric totals for this entry.",
      );
  }
  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.idempotencyKey))
    throw new CliError(
      "INVALID_IDEMPOTENCY_KEY",
      "Supply a stable idempotency key from 1 to 128 characters.",
      "Omit it to derive one, or reuse the same key when retrying an intended entry.",
    );
  if (
    input.occurrence !== undefined &&
    (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1 || input.occurrence > 999)
  )
    throw new CliError(
      "INVALID_OCCURRENCE",
      "Occurrence must be an integer from 1 to 999.",
      "Omit it for the first identical entry; use 2 for a second identical serving.",
    );
  validateWrite(input);
}

export function validateWrite(input: RefreshInput) {
  validateDate(input.date);
  if (input.dryRun && input.yes)
    throw new CliError(
      "CONFLICTING_OPTIONS",
      "Use --dry-run or --yes, not both.",
      "Preview first, then submit the same command with --yes.",
    );
  if (!input.dryRun && !input.yes)
    throw new CliError(
      "WRITE_CONFIRMATION_REQUIRED",
      "Diary changes require --dry-run or --yes.",
      "Use --dry-run to preview without changing Fitia.",
    );
}

export function validateRemove(input: RemoveInput) {
  validateWrite(input);
  if (!Object.hasOwn(mealTypes, input.meal))
    throw new CliError("INVALID_MEAL", "Unknown meal.", `Use ${Object.keys(mealTypes).join(", ")}.`);
  if (typeof input.itemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.itemId))
    throw new CliError(
      "INVALID_ITEM_ID",
      "Supply one exact item ID from the diary or a log receipt.",
      "Use --item-id with the entry's id from fitia meal get. Names, paths and wildcards are not accepted.",
    );
}

function entrySummary(fields: Fields) {
  const quick = string(fields.type) === "2";
  return {
    name: string(fields.name) ?? "Unknown entry",
    type: string(fields.type),
    eaten: fields.isEaten?.booleanValue === true,
    caloriesKcal: quick ? number(fields.calories) : null,
    proteinG: quick ? number(fields.proteins) : null,
    carbsG: quick ? number(fields.carbs) : null,
    fatG: quick ? number(fields.fats) : null,
    amount: string(fields.selectedNumberOfServingsRaw),
  };
}
function inputEntry(input: Entry): Entry {
  return {
    name: input.name.trim(),
    caloriesKcal: input.caloriesKcal,
    proteinG: input.proteinG,
    carbsG: input.carbsG,
    fatG: input.fatG,
  };
}
function matches(fields: Fields, entry: Entry) {
  return (
    string(fields.type) === "2" &&
    fields.isEaten?.booleanValue === true &&
    string(fields.name) === entry.name &&
    number(fields.calories) === entry.caloriesKcal &&
    number(fields.proteins) === entry.proteinG &&
    number(fields.carbs) === entry.carbsG &&
    number(fields.fats) === entry.fatG
  );
}

export class DiaryClient {
  private firestore: FirestoreDiaryAdapter;
  private writes: SafeWriteCoordinator<Document, { fields: Fields }>;

  constructor(
    private token?: string,
    private timeoutMs = 15000,
    private fetcher: Fetch = fetch,
    stateDir = stateDirectory(),
    private trustedAccountId?: string,
  ) {
    this.firestore = new FirestoreDiaryAdapter(token, timeoutMs, fetcher);
    this.writes = new SafeWriteCoordinator(
      stateDir,
      (document, body, fieldsChanged) => this.firestore.patch(document, body, fieldsChanged),
      (accountId, date) => this.read(accountId, date),
    );
  }

  private async read(uid: string, date: string): Promise<Document> {
    return this.firestore.readDailyRecord(uid, validateDate(date));
  }
  private async accountId() {
    return this.trustedAccountId ?? (await new FitiaClient(this.token, this.timeoutMs, this.fetcher).account()).id;
  }
  async get(date: string) {
    validateDate(date);
    const accountId = await this.accountId();
    const document = await this.read(accountId, date);
    const progress = map(document.fields.mealProgress);
    const meals = map(progress.meals);
    return {
      date,
      updateTime: document.updateTime,
      consumedCaloriesKcal: number(progress.consumedCalories),
      meals: Object.entries(meals).map(([id, value]) => {
        const meal = map(value),
          typeId = number(meal.typeID);
        return {
          id,
          typeId,
          name: Object.entries(mealTypes).find(([, n]) => n === typeId)?.[0] ?? "unknown",
          items: Object.entries(map(meal.mealItems)).map(([itemId, item]) => ({
            id: itemId,
            ...entrySummary(map(item)),
          })),
        };
      }),
      limitations: [
        "Food and recipe nutrient fields may be base values. Only quick entries (type 2) have totals here.",
        "Mobile display and cached nutrition scores depend on Fitia sync.",
      ],
    };
  }
  async summary(date: string) {
    validateDate(date);
    const document = await this.read(await this.accountId(), date);
    return summarizeDay(decodeFields(map(document.fields.mealProgress)), date, document.updateTime);
  }
  async suggest(input: SuggestInput) {
    validateDate(input.date);
    validateSuggestion(input);
    const accountId = await this.accountId(),
      document = await this.read(accountId, input.date);
    const day = summarizeDay(decodeFields(map(document.fields.mealProgress)), input.date, document.updateTime);
    const budget = suggestionBudget(day, input.meal);
    const result = {
      date: input.date,
      meal: input.meal,
      source: "fitia-planner",
      readOnly: true,
      status: "ok",
      day,
      budget,
      budgetRule:
        "Smaller of remaining day and meal calories; positive daily macros allocated in that calorie proportion.",
      rankingRule: "Least added macro excess, then smallest remaining macro fractions and calorie budget gap.",
      selectedFoodIds: [] as number[],
      language: null as string | null,
      returnedCount: 0,
      excludedCount: 0,
      suggestions: [] as ReturnType<typeof rankSuggestions>["suggestions"],
      warnings: [
        "Options are not logged. Confirm food, portion, cooking state, dietary restrictions and allergies before eating or logging.",
        "Fitia may return fewer options than the requested limit.",
      ],
    };
    if (!budget)
      return {
        ...result,
        status: "incomplete-diary",
        warnings: [
          ...result.warnings,
          "Consumed totals or goals are incomplete. Inspect the included day summary before choosing a food.",
        ],
      };
    if (budget.caloriesKcal < 1)
      return {
        ...result,
        status: "no-budget",
        warnings: [
          ...result.warnings,
          "No positive calorie budget remains for this meal. Targets are not a rule to skip eating; use food search for specific foods if needed.",
        ],
      };
    const preferenceKeys = [
      "tipoDieta",
      "pais",
      "databaseLanguage",
      "fechaCreacion",
      plannerMeals[input.meal].field,
      "restrictionsAndMealPreferences",
      "vegano",
    ];
    const userFields = await this.firestore.readUserFields(accountId, preferenceKeys);
    const preferences = decodeFields(
      Object.fromEntries(
        preferenceKeys.filter((key) => Object.hasOwn(userFields, key)).map((key) => [key, userFields[key]]),
      ),
    );
    if (needsDietaryReview(preferences))
      return {
        ...result,
        status: "dietary-review-required",
        warnings: [
          ...result.warnings,
          "Saved restrictions are present or unknown. This endpoint's allergy and dietary enforcement is unverified, so automatic suggestions were skipped. Review suitable foods explicitly.",
        ],
      };
    const request = suggestionRequest(preferences, accountId, input, budget);
    const response = await new FitiaClient(this.token, this.timeoutMs, this.fetcher).suggestFoods(request);
    const ranked = rankSuggestions(response, request, day, input.limit);
    return {
      ...result,
      ...ranked,
      selectedFoodIds: request.selectedFoods,
      language: request.language.toLowerCase(),
      status: ranked.suggestions.length ? "ok" : "no-matches",
    };
  }
  async log(input: LogInput) {
    validateLog(input);
    if (!input.dryRun) await this.checkKillswitch();
    const accountId = await this.accountId();
    const document = await this.read(accountId, input.date);
    const progress = map(document.fields.mealProgress),
      meals = map(progress.meals);
    const selected = Object.entries(meals).filter(([, value]) => number(map(value).typeID) === mealTypes[input.meal]);
    if (selected.length !== 1)
      throw new CliError(
        "MEAL_NOT_FOUND",
        "The diary does not have exactly one matching meal.",
        "Inspect fitia meal get. The CLI will not guess or create a meal container.",
        4,
      );
    const [mealId, value] = selected[0]!,
      meal = map(value),
      items = map(meal.mealItems);
    const entry = inputEntry(input);
    const idempotencyKey =
      input.idempotencyKey ??
      `auto:${createHash("sha256")
        .update(JSON.stringify([input.date, input.meal, entry, input.occurrence ?? 1]))
        .digest("hex")}`;
    const hash = createHash("sha256")
      .update(JSON.stringify([accountId, input.date, input.meal, idempotencyKey]))
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const receipt = {
      status: "preview",
      date: input.date,
      meal: input.meal,
      itemId: id,
      idempotencyKey,
      entry,
      kind: "quick-entry",
      serverVerified: false,
      mobileVerified: false,
    };
    if (items[id]) {
      if (!matches(map(items[id]), entry))
        throw new CliError(
          "IDEMPOTENCY_CONFLICT",
          "This key already identifies a different entry.",
          "Do not reuse an idempotency key for a different intended food log.",
        );
      return {
        ...receipt,
        status: "already-present",
        serverVerified: true,
        expectedUpdateTime: document.updateTime,
        fieldsChanged: [] as string[],
      };
    }
    const consumed = number(progress.consumedCalories);
    if (consumed === null || consumed < 0) invalidResponse();
    const orders = Object.values(items).map((item) => number(map(item).order));
    if (orders.some((order) => order === null || !Number.isSafeInteger(order) || order < 0)) invalidResponse();
    const fields: Fields = {
      ...encode({
        type: "2",
        uniqueID: id,
        name: entry.name,
        isEaten: true,
        calories: entry.caloriesKcal,
        proteins: entry.proteinG,
        carbs: entry.carbsG,
        fats: entry.fatG,
      }),
      order: { integerValue: String(Math.max(-1, ...(orders as number[])) + 1) },
      registrationDate: { timestampValue: new Date().toISOString() },
      registrationDateMeal: { timestampValue: timestamp(meal.registrationDateUTC) },
    };
    const mask = itemField(mealId, id);
    const fieldsChanged = [mask, "mealProgress.consumedCalories", "fcmToken"];
    // A copied device marker makes Fitia discard our write as its own echo.
    // Null is accepted as an external origin; never change account push tokens.
    const body = {
      fields: {
        fcmToken: { nullValue: null },
        mealProgress: {
          mapValue: {
            fields: {
              consumedCalories: { doubleValue: consumed + entry.caloriesKcal },
              meals: {
                mapValue: {
                  fields: {
                    [mealId]: {
                      mapValue: { fields: { mealItems: { mapValue: { fields: { [id]: { mapValue: { fields } } } } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    if (input.dryRun) return { ...receipt, expectedUpdateTime: document.updateTime, fieldsChanged };
    return this.commit(document, accountId, receipt, hash, body, fieldsChanged, (verified) => {
      const actual = map(map(map(map(verified.fields.mealProgress).meals)[mealId]).mealItems)[id];
      return !!actual && matches(map(actual), entry);
    });
  }
  async refresh(input: RefreshInput) {
    validateWrite(input);
    if (!input.dryRun) await this.checkKillswitch();
    const accountId = await this.accountId();
    const document = await this.read(accountId, input.date);
    const receipt = {
      status: "preview",
      date: input.date,
      kind: "mobile-refresh",
      serverVerified: false,
      mobileVerified: false,
    };
    if (document.fields.fcmToken?.nullValue === null)
      return {
        ...receipt,
        status: "already-requested",
        serverVerified: true,
        expectedUpdateTime: document.updateTime,
        fieldsChanged: [] as string[],
      };
    const fieldsChanged = ["fcmToken"],
      body = { fields: { fcmToken: { nullValue: null } } };
    if (input.dryRun) return { ...receipt, expectedUpdateTime: document.updateTime, fieldsChanged };
    const hash = createHash("sha256")
      .update(JSON.stringify([accountId, input.date, "refresh", document.updateTime]))
      .digest("hex");
    return this.commit(
      document,
      accountId,
      receipt,
      hash,
      body,
      fieldsChanged,
      (verified) => verified.fields.fcmToken?.nullValue === null,
    );
  }
  async remove(input: RemoveInput) {
    validateRemove(input);
    if (!input.dryRun) await this.checkKillswitch();
    const accountId = await this.accountId();
    const document = await this.read(accountId, input.date);
    const progress = map(document.fields.mealProgress),
      meals = map(progress.meals);
    const selected = Object.entries(meals).filter(([, value]) => number(map(value).typeID) === mealTypes[input.meal]);
    if (selected.length !== 1)
      throw new CliError(
        "MEAL_NOT_FOUND",
        "The diary does not have exactly one matching meal.",
        "Inspect fitia meal get. The CLI will not guess or create a meal container.",
        4,
      );
    const [mealId, value] = selected[0]!,
      items = map(map(value).mealItems);
    const consumed = number(progress.consumedCalories);
    if (consumed === null || consumed < 0) invalidResponse();
    const receipt = {
      status: "preview",
      date: input.date,
      meal: input.meal,
      itemId: input.itemId,
      kind: "remove-entry",
      serverVerified: false,
      mobileVerified: false,
    };
    if (!Object.hasOwn(items, input.itemId))
      return {
        ...receipt,
        status: "already-absent",
        entry: null,
        caloriesRemovedKcal: 0,
        consumedCaloriesBeforeKcal: consumed,
        consumedCaloriesAfterKcal: consumed,
        serverVerified: true,
        expectedUpdateTime: document.updateTime,
        fieldsChanged: [] as string[],
      };
    const fields = map(items[input.itemId]);
    if (string(fields.type) !== "2")
      throw new CliError(
        "UNSUPPORTED_ENTRY_TYPE",
        "Removal currently supports quick entries only, including all entries made by this CLI.",
        "Remove database food or recipe entries in Fitia until their serving totals are verified. Nothing was changed.",
        4,
      );
    const calories = number(fields.calories),
      eaten = fields.isEaten?.booleanValue;
    if (calories === null || calories < 0 || typeof eaten !== "boolean") invalidResponse();
    const entry = entrySummary(fields);
    for (const amount of [entry.proteinG, entry.carbsG, entry.fatG])
      if (amount !== null && amount < 0) invalidResponse();
    const caloriesRemovedKcal = eaten ? calories : 0;
    const remaining = consumed - caloriesRemovedKcal;
    if (remaining < -0.000001)
      throw new CliError(
        "DIARY_TOTAL_CONFLICT",
        "The entry has more consumed calories than the day's recorded total.",
        "Check this day in Fitia before removing it. The CLI will not guess a replacement total.",
        4,
      );
    const consumedCaloriesAfterKcal = Math.max(0, remaining);
    const preview = {
      ...receipt,
      entry,
      caloriesRemovedKcal,
      consumedCaloriesBeforeKcal: consumed,
      consumedCaloriesAfterKcal,
    };
    const fieldsChanged = [itemField(mealId, input.itemId), "mealProgress.consumedCalories", "fcmToken"];
    // A masked field omitted from the body is deleted by Firestore. Sending a
    // null item or replacing mealItems would not preserve the other entries.
    const body = {
      fields: {
        mealProgress: { mapValue: { fields: { consumedCalories: { doubleValue: consumedCaloriesAfterKcal } } } },
        fcmToken: { nullValue: null },
      },
    };
    if (input.dryRun) return { ...preview, expectedUpdateTime: document.updateTime, fieldsChanged };
    const hash = createHash("sha256")
      .update(JSON.stringify(["remove", accountId, input.date, input.meal, input.itemId]))
      .digest("hex");
    return this.commit(document, accountId, preview, hash, body, fieldsChanged, (verified) => {
      const actual = map(map(map(map(verified.fields.mealProgress).meals)[mealId]).mealItems);
      return (
        !Object.hasOwn(actual, input.itemId) &&
        number(map(verified.fields.mealProgress).consumedCalories) === consumedCaloriesAfterKcal
      );
    });
  }
  private async commit<
    T extends { date: string; status: string; serverVerified: boolean; mobileVerified: boolean; itemId?: string },
  >(
    document: Document,
    accountId: string,
    receipt: T,
    hash: string,
    body: { fields: Fields },
    fieldsChanged: string[],
    verify: (document: Document) => boolean,
  ) {
    return this.writes.execute({ document, accountId, receipt, hash, body, fieldsChanged, verify });
  }

  private async checkKillswitch() {
    return this.writes.assertEnabled();
  }
}

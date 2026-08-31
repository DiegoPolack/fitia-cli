import { expect, test } from "bun:test";
import { DiaryClient } from "@fitia/core";
import Ajv from "ajv";
import { schema } from "../apps/cli/src/contract/index.ts";

const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.sig`;
const base =
  "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/verified-user";
const endpoint = "https://planner.fitia.app/api/v1/yuki/food-suggestions";
const input = { date: "2026-08-30", meal: "dinner" as const, limit: 5 };
const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(
  schema().commands.find((c) => c.name === "meal suggest")!.data,
);
function encode(value: any): any {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } };
}
function food(id = "1", size = 200) {
  return {
    firestoreDocId: id,
    name: [{ language: "ES", name: "Pollo de prueba" }],
    selectedSize: size,
    cookingState: "Raw",
    servingSettings: [{ system: "metric", servingUnit: "g", servingSize: 100 }],
    recommendations: [{ language: "ES", recommendation: ["Preparación de prueba"] }],
    caloriesPerGram: 1.2,
    proteinPerGram: 0.225,
    carbsPerGram: 0,
    fatPerGram: 0.0262,
    iconURL: "private-url-omitted",
  };
}
function harness(options: { status?: number; fail?: boolean; body?: unknown } = {}) {
  const day: any = {
    mealProgress: {
      targetCalories: 1681.625,
      targetProteins: 140.4,
      targetCarbs: 153.884375,
      targetFats: 56.054167,
      consumedCalories: 1394.2,
      meals: {
        lunch: {
          typeID: 2,
          targetCalories: 607,
          mealItems: {
            quick: {
              name: "Synthetic entry",
              type: "2",
              isEaten: true,
              calories: 1394.2,
              proteins: 78.129,
              carbs: 163.609,
              fats: 49.165,
            },
          },
        },
        dinner: { typeID: 4, targetCalories: 420.40625, mealItems: {} },
      },
    },
  };
  const preferences: any = {
    tipoDieta: "Recomendada",
    pais: "PE",
    databaseLanguage: "ES",
    fechaCreacion: "2024-02-10T23:18:24.321Z",
    availableDinnerPlannerFoods: ["1", "4", "14"],
    restrictionsAndMealPreferences: { allergies: [], medicalConditions: [] },
    vegano: false,
    lastFCMToken: "private-marker-omitted",
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new DiaryClient(token, 1000, async (url, init) => {
    calls.push({ url, init });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeDefined();
    if (url.includes("accounts:lookup"))
      return Response.json({ users: [{ localId: "verified-user", emailVerified: true }] });
    expect((init.headers as any).Authorization).toBe(`Bearer ${token}`);
    if (url === `${base}/dailyRecords/30-08-2026`) {
      expect(init.method).toBeUndefined();
      return Response.json({
        name: `${base.replace("https://firestore.googleapis.com/v1/", "")}/dailyRecords/30-08-2026`,
        updateTime: "2026-08-30T21:49:05.768551Z",
        fields: encode(day).mapValue.fields,
      });
    }
    if (url.startsWith(`${base}?`)) {
      expect(init.method).toBeUndefined();
      const mask = new URL(url).searchParams.getAll("mask.fieldPaths");
      expect(mask).toContain("availableDinnerPlannerFoods");
      expect(mask).not.toContain("lastFCMToken");
      return Response.json({
        name: base.replace("https://firestore.googleapis.com/v1/", ""),
        fields: encode(preferences).mapValue.fields,
      });
    }
    expect(url).toBe(endpoint);
    expect(init.method).toBe("POST");
    if (options.fail) throw new Error("private provider error");
    if (options.status) return new Response("private provider error", { status: options.status });
    return Response.json(options.body ?? [[food()]]);
  });
  return { client, day, preferences, calls };
}
test("native suggestions use verified own identity, integer grams, meal preferences and remaining calories; no writes", async () => {
  const h = harness(),
    before = structuredClone(h.day);
  const result = await h.client.suggest(input);
  expect(result.status).toBe("ok");
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  const request = JSON.parse(h.calls.find((c) => c.url === endpoint)!.init.body as string);
  expect(request).toEqual({
    dietType: "Recomendada",
    minCalories: 200,
    maxCalories: 287,
    targetCalories: 287,
    targetProteins: 62,
    targetCarbs: 0,
    targetFats: 6,
    mealType: "dinner",
    selectedFoods: [1, 4, 14],
    measurementSystem: "metric",
    country: "PE",
    language: "ES",
    creationDate: "2024-02-10T23:18:24.321Z",
    userID: "verified-user",
  });
  expect(result.suggestions[0]!.totals).toEqual({ caloriesKcal: 240, proteinG: 45, carbsG: 0, fatG: 5.24 });
  expect(result.suggestions[0]!.remainingAfter.caloriesKcal).toBe(47.425);
  expect(result.suggestions[0]!.foods[0]!.entry.name).toContain("200 g (Raw)");
  expect(JSON.stringify(result)).not.toMatch(/private-|verified-user|Bearer/);
  expect(h.day).toEqual(before);
  expect(h.calls).toHaveLength(4);
  expect(h.calls.some((c) => ["PATCH", "DELETE", "PUT"].includes(c.init.method!))).toBe(false);
});
test("native results are filtered, deduplicated and ranked by macro tradeoffs", async () => {
  const fatty = { ...food("4"), fatPerGram: 0.05 };
  const lean = { ...food("14"), caloriesPerGram: 1.3, proteinPerGram: 0.25, fatPerGram: 0.02 };
  const h = harness({ body: [[fatty], [food()], [lean], [food()], [food("999")], [food("1", 400)]] });
  const result = await h.client.suggest(input);
  expect(result.returnedCount).toBe(6);
  expect(result.excludedCount).toBe(3);
  expect(result.suggestions.map((s) => s.foods[0]!.id)).toEqual(["14", "1", "4"]);
  expect(result.suggestions[2]!.tradeoffs.some((t) => t.includes("Fat:"))).toBe(true);
});
test("food IDs only narrow existing preferences", async () => {
  const h = harness();
  const result = await h.client.suggest({ ...input, foods: [1] });
  expect(result.selectedFoodIds).toEqual([1]);
  await expect(h.client.suggest({ ...input, foods: [999] })).rejects.toMatchObject({ code: "FOOD_NOT_SELECTED" });
});
test.each(["0", "1", "3"])("unknown eaten type %s skips planner and preferences calls", async (type) => {
  const h = harness();
  h.day.mealProgress.meals.lunch.mealItems.quick.type = type;
  const result = await h.client.suggest(input);
  expect(result.status).toBe("incomplete-diary");
  expect(result.suggestions).toEqual([]);
  expect(h.calls).toHaveLength(2);
  expect(validate(result)).toBe(true);
});
test("over-calorie and already-filled meals skip planner without negative budgets or food advice", async () => {
  const h = harness();
  h.day.mealProgress.targetCalories = 1000;
  const result = await h.client.suggest(input);
  expect(result.status).toBe("no-budget");
  expect(h.calls).toHaveLength(2);
  expect(validate(result)).toBe(true);
});
test("calorie conflicts and missing goals disable automatic budgets", async () => {
  const h = harness();
  h.day.mealProgress.consumedCalories = 10;
  expect((await h.client.suggest(input)).status).toBe("incomplete-diary");
  h.day.mealProgress.consumedCalories = 1394.2;
  delete h.day.mealProgress.targetProteins;
  expect((await h.client.suggest(input)).status).toBe("incomplete-diary");
});
test("restrictions and unknown dietary preferences require review instead of inventing allergen safety", async () => {
  const h = harness();
  h.preferences.restrictionsAndMealPreferences.allergies = ["milk"];
  let result = await h.client.suggest(input);
  expect(result.status).toBe("dietary-review-required");
  expect(validate(result)).toBe(true);
  expect(h.calls).toHaveLength(3);
  delete h.preferences.restrictionsAndMealPreferences;
  result = await h.client.suggest(input);
  expect(result.status).toBe("dietary-review-required");
});
test("empty native results are a valid no-match result", async () => {
  const result = await harness({ body: [] }).client.suggest(input);
  expect(result.status).toBe("no-matches");
  expect(validate(result)).toBe(true);
});
test.each(["selectedSize", "proteinPerGram", "servingSettings", "cookingState"])(
  "missing %s cannot create a log-ready option",
  async (key) => {
    const f: any = food();
    delete f[key];
    await expect(harness({ body: [[f]] }).client.suggest(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  },
);
test("ambiguous units, control characters and nonfinite amounts fail closed", async () => {
  for (const f of [
    { ...food(), servingSettings: [{ system: "metric", servingUnit: "oz", servingSize: 1 }] },
    { ...food(), selectedSize: null },
    { ...food(), proteinPerGram: -1 },
    { ...food(), name: [{ language: "ES", name: "Bad\u001b[2J" }] },
  ]) {
    await expect(harness({ body: [[f]] }).client.suggest(input)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  }
});
test.each([401, 403, 429, 500])("HTTP %s is not retried and leaks no upstream error", async (status) => {
  const h = harness({ status });
  try {
    await h.client.suggest(input);
    throw Error("Expected failure");
  } catch (e: any) {
    expect(e.message).not.toContain("private");
    expect(e.exitCode).toBe(status < 429 ? 3 : 4);
  }
  expect(h.calls.filter((c) => c.url === endpoint)).toHaveLength(1);
});
test("invalid inputs fail before authentication", async () => {
  const h = harness();
  for (const bad of [
    { ...input, date: "not-date" },
    { ...input, limit: 11 },
    { ...input, foods: [1, 1] },
    { ...input, foods: [] },
  ])
    await expect(h.client.suggest(bad)).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});

import { expect, test } from "bun:test";
import { type Fetch, FitiaClient } from "@fitia/core";
import fixture from "./fixtures/food-search.json";

const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
const response = () => structuredClone(fixture);
const client = (data: unknown) => new FitiaClient(token, 1000, async () => Response.json(data));

test("search reproduces the captured read contract at a fixed origin", async () => {
  let calls = 0;
  const fetcher: Fetch = async (url, init) => {
    calls++;
    expect(url).toBe("https://us-central1-fitia-27c84.cloudfunctions.net/generalSearchV5");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(token);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      search: "sample",
      search_own_db: true,
      language: "ES",
      size: 5,
      app_platform: "iOS",
      app_build_number: 1069,
      country: "PE",
      search_verified: true,
    });
    return Response.json(response());
  };
  const result = await new FitiaClient(token, 1000, fetcher).searchFoods(" sample ", "PE", "ES", 5);
  expect(calls).toBe(1);
  expect(result.count).toBe(1);
  expect(result).not.toHaveProperty("total");
  expect(JSON.stringify(result)).not.toContain("secret-omitted");
  expect(JSON.stringify(result)).not.toContain("search-engine-internal-id");
});

test("gram basis matches a 120 g serving without interpreting it as 120 units", async () => {
  const food = (await client(response()).searchFoods("sample")).foods[0]!;
  expect(food.nutrition.basis).toBe("per-gram");
  expect(food.nutrition.values.calories).toEqual({ amount: 1.2, unit: "kcal" });
  expect(food.nutrition.per100).toEqual({ caloriesKcal: 120, proteinG: 22.5, carbsG: 0, fatG: 2.62 });
  expect(food.servings[0]!.size! * food.nutrition.values.calories!.amount).toBe(144);
  expect(food.quickEntries[0]).toEqual({
    serving: { name: "sample serving", size: 120, unit: "g", quantity: "1" },
    entry: {
      name: "Synthetic sample, 1 sample serving (120 g)",
      caloriesKcal: 144,
      proteinG: 27,
      carbsG: 0,
      fatG: 3.144,
    },
  });
});

test("liquid nutrition uses milliliters and preserves missing values", async () => {
  const data = response();
  data.hits[0]!._source.servings = [{ name: "milliliter", size: 1, unit: "ml", quantity: "1", default: true }];
  data.hits[0]!._source.nutrients.calories.size = 0.61;
  (data.hits[0]!._source.nutrients as any).protein = null;
  const food = (await client(data).searchFoods("sample")).foods[0]!;
  expect(food.nutrition.basis).toBe("per-milliliter");
  expect(food.nutrition.per100!.caloriesKcal).toBe(61);
  expect(food.nutrition.per100!.proteinG).toBeNull();
  expect(food.nutrition.per100!.carbsG).toBe(0);
});

test.each(["missing", "ambiguous"])("%s metric basis does not guess nutrition scaling", async (kind) => {
  const data = response();
  if (kind === "missing") data.hits[0]!._source.servings = [];
  else data.hits[0]!._source.servings.push({ name: "milliliter", size: 1, unit: "ml", quantity: "1", default: true });
  const food = (await client(data).searchFoods("sample")).foods[0]!;
  expect(food.nutrition.basis).toBe("unverified");
  expect(food.nutrition.per100).toBeNull();
});

test("an unexpected energy unit is preserved without pretending it is kcal", async () => {
  const data = response();
  data.hits[0]!._source.nutrients.calories.unit = "kJ";
  const food = (await client(data).searchFoods("sample")).foods[0]!;
  expect(food.nutrition.per100!.caloriesKcal).toBeNull();
  expect(food.nutrition.values.calories!.unit).toBe("kJ");
});

test("empty search results are valid", async () => {
  expect((await client({ hits: [], total: { value: 0 } }).searchFoods("sample")).foods).toEqual([]);
});

test("a zero-sized placeholder is unknown, not a zero-calorie serving", async () => {
  const data = response();
  data.hits[0]!._source.servings[0]!.size = 0;
  const food = (await client(data).searchFoods("sample")).foods[0]!;
  expect(food.servings[0]!.size).toBeNull();
  expect(food.nutrition.per100!.caloriesKcal).toBe(120);
});

test("recipe macros stay per serving even when gram servings are present", async () => {
  const data: any = response();
  const source = data.hits[0]._source;
  source.collection = "recipe";
  delete source.nutrients;
  source.macros_per_serving = { calories: 650, protein: 30, carbs: 90, fat: 19 };
  const food = (await client(data).searchFoods("sample")).foods[0]!;
  expect(food.nutrition.basis).toBe("per-serving");
  expect(food.nutrition.per100).toBeNull();
  expect(food.nutrition.perServing).toEqual({ caloriesKcal: 650, proteinG: 30, carbsG: 90, fatG: 19 });
  expect(food.nutrition.values.calories).toEqual({ amount: 650, unit: "kcal" });
  expect(food.quickEntries).toEqual([
    {
      serving: { name: "sample serving", size: 120, unit: "g", quantity: "1" },
      entry: {
        name: "Synthetic sample, 1 sample serving (120 g)",
        caloriesKcal: 650,
        proteinG: 30,
        carbsG: 90,
        fatG: 19,
      },
    },
  ]);
});

test("recipe quick entries require exactly one non-metric serving", async () => {
  const data: any = response();
  const source = data.hits[0]._source;
  source.collection = "recipe";
  delete source.nutrients;
  source.macros_per_serving = { calories: 650, protein: 30, carbs: 90, fat: 19 };
  source.servings.push({ name: "bowl", size: 240, unit: "g", quantity: "1", default: false });
  expect((await client(data).searchFoods("sample")).foods[0]!.quickEntries).toEqual([]);

  source.servings = [{ name: "ml", size: 1, unit: "ml", quantity: "1", default: true }];
  expect((await client(data).searchFoods("sample")).foods[0]!.quickEntries).toEqual([]);
});

test("negative nutrients and malformed response data fail closed", async () => {
  const data = response();
  data.hits[0]!._source.nutrients.calories.size = -1;
  await expect(client(data).searchFoods("sample")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  await expect(client({ error: "private upstream message" }).searchFoods("sample")).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
});

test("search validates input and authentication before the request", async () => {
  let calls = 0;
  const fetcher: Fetch = async () => {
    calls++;
    return Response.json(response());
  };
  const c = new FitiaClient(token, 1000, fetcher);
  await expect(c.searchFoods(" ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(c.searchFoods("sample", "pe", "es", 51)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(c.searchFoods("sample", "pe", "de")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(new FitiaClient(undefined, 1000, fetcher).searchFoods("sample")).rejects.toMatchObject({
    code: "AUTH_REQUIRED",
  });
  expect(calls).toBe(0);
});

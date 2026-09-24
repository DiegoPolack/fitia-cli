import { expect, test } from "bun:test";
import { quickEntryIdentity } from "@fitia/core/diary";
import { defaultGainerConfig } from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { InMemoryTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/server";
import { createServer } from "../apps/mcp/src/server.ts";

async function client(options: Parameters<typeof createServer>[0]) {
  const server = createServer(options);
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await transport.start();
  let id = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = new Promise<Record<string, any>>((resolve) => {
      transport.onmessage = (message) => resolve(message as Record<string, any>);
    });
    await transport.send({ jsonrpc: "2.0", id: ++id, method, params });
    return response;
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "synthetic-gainer-test", version: "1" },
  });
  await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, initialized, close: () => transport.close() };
}
test("MCP exposes bundled skill in initialization/resource and strict gainer schemas", async () => {
  const rpc = await client({ canWrite: false });
  try {
    expect(rpc.initialized.result.instructions).toContain("Never reconstruct the recipe");
    const listed = (await rpc.request("resources/list", {})).result.resources;
    expect(listed).toContainEqual(expect.objectContaining({ uri: "fitia://skills/fitia-gainer" }));
    const resource = (await rpc.request("resources/read", { uri: "fitia://skills/fitia-gainer" })).result.contents[0]
      .text;
    expect(resource).toContain("expectedVersion");
    expect(resource).not.toContain("578.5");
    const tools = (await rpc.request("tools/list", {})).result.tools;
    expect(tools.find((t: any) => t.name === "fitia-gainer-calculate").annotations.readOnlyHint).toBe(true);
    expect(tools.find((t: any) => t.name === "fitia-gainer-calculate").inputSchema.properties.mode.enum).toContain(
      "fitia_adaptive",
    );
    expect(resource).toContain("fitia_adaptive");
    expect(resource).toContain("legacy_v1");
    const update = tools.find((t: any) => t.name === "fitia-gainer-config-update");
    expect(update.inputSchema.properties.confirm.default).toBe(false);
    expect(update.inputSchema.additionalProperties).toBe(false);
    expect(update._meta.securitySchemes[0].scopes).toEqual(["fitia:read", "fitia:write"]);
    expect(update.inputSchema.properties.patch.properties.activeProfile.enum).toEqual(["legacy_v1", "future_v2"]);
    expect(JSON.stringify(update.inputSchema)).toContain("gramsPer100MlWater");
    expect(JSON.stringify(update.inputSchema)).toContain("maltodex");
    expect(update.inputSchema.properties.patch.properties.adaptive.properties.strategy.enum).toEqual([
      "legacy_v1",
      "proportional_v2",
    ]);
    expect(JSON.stringify(update.inputSchema)).toContain("ingredientDeviation");
    expect(resource).toContain("proportional_v2");
    const config = await rpc.request("tools/call", { name: "fitia-gainer-config-get", arguments: {} });
    expect(JSON.parse(config.result.content[0].text)).toMatchObject({
      config: {
        activeProfile: "legacy_v1",
        recipeProfiles: {
          legacy_v1: { ingredients: { maltodex: { enabled: false, nutrition: { macros: { proteinG: null } } } } },
        },
      },
    });
    const carryoverUpdate = tools.find((t: any) => t.name === "fitia-gainer-carryover-update");
    expect(carryoverUpdate.inputSchema.type).toBe("object");
    expect(carryoverUpdate.inputSchema.additionalProperties).toBe(false);
    expect(carryoverUpdate.inputSchema.properties.confirm.default).toBe(false);
    expect(JSON.stringify(carryoverUpdate.inputSchema)).toContain("adaptivePreparation");
    expect(carryoverUpdate._meta.securitySchemes[0].scopes).toEqual(["fitia:read", "fitia:write"]);
  } finally {
    await rpc.close();
  }
});

test("carryover mutation scope and input checks run before the repository", async () => {
  let mutations = 0;
  const rpc = await client({
    canWrite: false,
    gainerCarryover: {
      async list() {
        return [];
      },
      async update() {
        mutations++;
        return {};
      },
    },
  });
  try {
    for (const confirm of [false, true]) {
      const response = await rpc.request("tools/call", {
        name: "fitia-gainer-carryover-update",
        arguments: { action: "cancelled", carryoverId: "a".repeat(64), confirm, expectedVersion: "1" },
      });
      expect(response.result.isError).toBe(true);
    }
    for (const args of [{ date: "2026-09-15", clerkUserId: "other" }, { date: "not-a-date" }]) {
      const response = await rpc.request("tools/call", { name: "fitia-gainer-carryover-get", arguments: args });
      expect(response.error !== undefined || response.result?.isError === true).toBe(true);
    }
    const invalid = await rpc.request("tools/call", {
      name: "fitia-gainer-carryover-update",
      arguments: { action: "save", confirm: false },
    });
    expect(invalid.error !== undefined || invalid.result?.isError === true).toBe(true);
    expect(mutations).toBe(0);
  } finally {
    await rpc.close();
  }
});

test("MCP split and next-day pending/registered calculations only GET Fitia and never save or log", async () => {
  const config = { ...defaultGainerConfig(), sweetenerInventory: "honey_only" as const };
  const plan = makeCarryoverPlan(
    {
      sourceDate: "2026-09-14",
      recipeId: "polack_labs_mass_gainer_v1",
      scaleFactor: 1.47,
      sweetener: "honey_only",
      nightPercent: 68,
    },
    config,
  );
  const pending = { ...plan, status: "pending" as const, version: "1", consumedEntry: null };
  let registered = false,
    requests = 0,
    writes = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toStartWith("https://firestore.googleapis.com/");
      expect(init?.method ?? "GET").toBe("GET");
      requests++;
      const source = String(url).endsWith("14-09-2026");
      const macros = source
        ? { caloriesKcal: 1983, proteinG: 148, carbsG: 185, fatG: 71 }
        : registered
          ? plan.nutrition
          : { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
      const id = source
        ? "source-eaten"
        : quickEntryIdentity("test-user", "2026-09-15", "breakfast", plan.morningCarryoverMealLog.idempotencyKey).id;
      return Response.json({
        name: String(url).split("/v1/")[1],
        updateTime: "2026-09-15T12:00:00Z",
        fields: fields({
          mealProgress: {
            targetCalories: 2940,
            targetProteins: 110,
            targetCarbs: 400,
            targetFats: 98,
            consumedCalories: macros.caloriesKcal,
            meals: {
              breakfast: {
                typeID: 0,
                mealItems:
                  source || registered
                    ? {
                        [id]: {
                          type: "2",
                          name: source ? "source" : plan.morningCarryoverMealLog.name,
                          isEaten: true,
                          calories: macros.caloriesKcal,
                          proteins: macros.proteinG,
                          carbs: macros.carbsG,
                          fats: macros.fatG,
                        },
                      }
                    : {},
              },
            },
          },
        }),
      });
    },
    { preconnect: previousFetch.preconnect },
  );
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`;
  const rpc = await client({
    token,
    trustedAccountId: "test-user",
    canWrite: true,
    gainerConfig: {
      async get() {
        return { config, version: "1", persisted: true };
      },
      async update() {
        writes++;
        return {};
      },
    },
    gainerCarryover: {
      async list(date) {
        return date === "2026-09-15" ? [pending] : [];
      },
      async update() {
        writes++;
        return {};
      },
    },
  });
  const calculate = async (date: string) => {
    const response = await rpc.request("tools/call", {
      name: "fitia-gainer-calculate",
      arguments: { date, mode: "fitia_optimal" },
    });
    if (response.result.isError) throw new Error(response.result.content[0].text);
    expect(response.result.isError).not.toBe(true);
    return JSON.parse(response.result.content[0].text);
  };
  try {
    const source = await calculate("2026-09-14");
    expect(source.servingStrategy).toBe("split_next_morning");
    expect(source.carryoverDraft.configVersion).toBe("1");
    expect(source.suggestedMealLog).toEqual(source.nightMealLog);
    expect(requests).toBe(1);
    const tomorrow = await calculate("2026-09-15");
    expect(tomorrow.fitia.consumed.caloriesKcal).toBe(0);
    expect(tomorrow.carryover.plannedNutrition).toEqual(plan.nutrition);
    expect(tomorrow.optimization.maxAdditionalCaloriesKcal).toBeCloseTo(3234 - plan.nutrition.caloriesKcal, 5);
    registered = true;
    const consumed = await calculate("2026-09-15");
    expect(consumed.fitia.consumed).toEqual(plan.nutrition);
    expect(consumed.carryover.plannedNutrition.caloriesKcal).toBe(0);
    expect(consumed.carryover.recordedNutrition).toEqual(plan.nutrition);
    expect(consumed.planningConsumed.caloriesKcal).toBe(0);
    expect(consumed.registeredConsumed).toEqual(plan.nutrition);
    expect(consumed.excludedCarryoverFromPlanning).toEqual(plan.nutrition);
    expect(consumed.optimization.maxAdditionalCaloriesKcal).toBe(3234);
    expect(writes).toBe(0);
    expect(requests).toBe(5);
    expect(await calculate("2026-09-15")).toEqual(consumed);
    expect(requests).toBe(7);
    expect(writes).toBe(0);
    expect(pending.status).toBe("pending");
    for (const date of ["2026-09-14", "2026-09-15"]) {
      const adaptive = await rpc.request("tools/call", {
        name: "fitia-gainer-calculate",
        arguments: { date, mode: "fitia_adaptive", sweetener: "none" },
      });
      expect(adaptive.result.isError).not.toBe(true);
      const result = JSON.parse(adaptive.result.content[0].text);
      expect(result.optimization.mode).toBe("fitia_adaptive");
      expect(result.configUsed.defaultMode).toBe("fitia_optimal");
      expect(result.sweetener.mode).toBe("none");
      if (date.endsWith("15")) {
        expect(result.planningConsumed.caloriesKcal).toBe(0);
        expect(result.excludedCarryoverFromPlanning).toEqual(plan.nutrition);
      }
      if (result.carryoverDraft) expect(result.carryoverDraft.adaptiveAmounts).toEqual(result.optimization.amounts);
    }
    expect(writes).toBe(0);

    const stale = await rpc.request("tools/call", {
      name: "fitia-gainer-carryover-update",
      arguments: { action: "save", draft: { ...source.carryoverDraft, configVersion: "0" }, confirm: false },
    });
    expect(JSON.parse(stale.result.content[0].text).error.code).toBe("CONFIG_VERSION_CONFLICT");
    expect(writes).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    await rpc.close();
  }
});
test("MCP sizes from normal intake after a verified 61/39 carryover, without changing inventory", async () => {
  const date = "2026-09-16";
  const config = { ...defaultGainerConfig(), sweetenerInventory: "honey_only" as const };
  const plan = makeCarryoverPlan(
    {
      sourceDate: "2026-09-15",
      recipeId: "polack_labs_mass_gainer_v1",
      scaleFactor: 1.65,
      sweetener: "honey_only",
      nightPercent: 61,
    },
    config,
  );
  const record = { ...plan, status: "pending" as const, version: "1", consumedEntry: null };
  const normal = { caloriesKcal: 1413, proteinG: 80, carbsG: 153, fatG: 50 };
  const entryId = quickEntryIdentity("test-user", date, "breakfast", plan.morningCarryoverMealLog.idempotencyKey).id;
  const item = (nutrition: typeof normal) => ({
    type: "2",
    name: "synthetic meal",
    isEaten: true,
    calories: nutrition.caloriesKcal,
    proteins: nutrition.proteinG,
    carbs: nutrition.carbsG,
    fats: nutrition.fatG,
  });
  const previousFetch = globalThis.fetch;
  let requests = 0,
    writes = 0,
    wholeUnits = false;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toStartWith("https://firestore.googleapis.com/");
      expect(String(url)).toEndWith("16-09-2026");
      expect(init?.method ?? "GET").toBe("GET");
      requests++;
      const storedNutrition = wholeUnits ? { caloriesKcal: 445, proteinG: 13, carbsG: 75, fatG: 10 } : plan.nutrition;
      return Response.json({
        name: String(url).split("/v1/")[1],
        updateTime: "2026-09-16T20:00:00Z",
        fields: fields({
          mealProgress: {
            targetCalories: 2028,
            targetProteins: 110,
            targetCarbs: 270,
            targetFats: 67.6,
            consumedCalories: normal.caloriesKcal + storedNutrition.caloriesKcal,
            meals: { breakfast: { typeID: 0, mealItems: { normal: item(normal), [entryId]: item(storedNutrition) } } },
          },
        }),
      });
    },
    { preconnect: previousFetch.preconnect },
  );
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`;
  const rpc = await client({
    token,
    trustedAccountId: "test-user",
    canWrite: true,
    gainerConfig: {
      async get() {
        return { config, version: "9", persisted: true };
      },
      async update() {
        writes++;
        return {};
      },
    },
    gainerCarryover: {
      async list(targetDate) {
        expect(targetDate).toBe(date);
        return [record];
      },
      async update() {
        writes++;
        return {};
      },
    },
  });
  const read = async (name: string, args: Record<string, unknown>) => {
    const response = await rpc.request("tools/call", { name, arguments: args });
    expect(response.result.isError).not.toBe(true);
    return JSON.parse(response.result.content[0].text);
  };
  try {
    const summary = await read("fitia-day-summary", { date });
    const calculate = () => read("fitia-gainer-calculate", { date, mode: "fitia_optimal", sweetener: "none" });
    const result = await calculate();
    expect(result.fitia).toEqual(summary);
    expect(result.registeredConsumed).toEqual(summary.consumed);
    expect(result.planningConsumed).toEqual(normal);
    expect(result.excludedCarryoverFromPlanning).toEqual(plan.nutrition);
    expect(result.carryover.optimizationConsumed).toEqual(normal);
    expect(result.practicalNutrition.caloriesKcal).toBeGreaterThanOrEqual(600);
    expect(result.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(620);
    expect(result.effectiveProjection.consumedAfter.caloriesKcal).toBeCloseTo(
      normal.caloriesKcal + result.practicalNutrition.caloriesKcal,
      5,
    );
    expect(result.fitiaProjection.consumedAfter.caloriesKcal).toBeCloseTo(
      summary.consumed.caloriesKcal + result.practicalNutrition.caloriesKcal,
      5,
    );
    expect(result.sweetener.mode).toBe("none");
    expect(result.configVersion).toBe("9");
    expect(await calculate()).toEqual(result);
    expect(requests).toBe(5);
    wholeUnits = true;
    const normalized = await calculate();
    expect(normalized.planningConsumed).toEqual(normal);
    expect(normalized.baseMix).toEqual(result.baseMix);
    expect(normalized.registeredConsumed.caloriesKcal).toBe(1858);
    expect(normalized.excludedCarryoverFromPlanning).toEqual({ caloriesKcal: 445, proteinG: 13, carbsG: 75, fatG: 10 });
    expect(normalized.carryover.items[0].verificationNutritionBasis).toBe("whole_units");
    expect(requests).toBe(7);
    const saved = await read("fitia-gainer-config-get", {});
    expect(saved.config).toEqual(config);
    expect(saved.version).toBe("9");
    expect(writes).toBe(0);
    expect(record.status).toBe("pending");
  } finally {
    globalThis.fetch = previousFetch;
    await rpc.close();
  }
});
test("read-only grant cannot even preview config mutations; user IDs cannot be injected", async () => {
  let updates = 0;
  const rpc = await client({
    canWrite: false,
    resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
    gainerConfig: {
      async get() {
        return { config: defaultGainerConfig(), version: "0", persisted: false };
      },
      async update() {
        updates++;
        return {};
      },
    },
  });
  try {
    for (const confirm of [false, true]) {
      const result = (
        await rpc.request("tools/call", {
          name: "fitia-gainer-config-update",
          arguments: { patch: { sweetenerInventory: "both" }, confirm, expectedVersion: "0" },
        })
      ).result;
      expect(result.isError).toBe(true);
      expect(result._meta["mcp/www_authenticate"][0]).toContain("insufficient_scope");
    }
    expect(updates).toBe(0);
    const invalid = await rpc.request("tools/call", {
      name: "fitia-gainer-config-get",
      arguments: { clerkUserId: "user_other" },
    });
    expect(invalid.error !== undefined || invalid.result?.isError === true).toBe(true);
  } finally {
    await rpc.close();
  }
});

function fields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      typeof v === "number"
        ? { doubleValue: v }
        : typeof v === "boolean"
          ? { booleanValue: v }
          : typeof v === "string"
            ? { stringValue: v }
            : { mapValue: { fields: fields(v as Record<string, unknown>) } },
    ]),
  );
}

test("saved carryover can be retrieved before tomorrow's diary exists, without masking other provider failures", async () => {
  const plan = makeCarryoverPlan(
    {
      sourceDate: "2026-09-14",
      recipeId: "polack_labs_mass_gainer_v1",
      scaleFactor: 1.47,
      sweetener: "honey_only",
      nightPercent: 68,
    },
    defaultGainerConfig(),
  );
  const record = { ...plan, status: "pending" as const, version: "1", consumedEntry: null };
  const previousFetch = globalThis.fetch;
  let status = 404;
  globalThis.fetch = Object.assign(async () => new Response(null, { status }), {
    preconnect: previousFetch.preconnect,
  });
  const rpc = await client({
    token: `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`,
    trustedAccountId: "test-user",
    canWrite: false,
    gainerCarryover: {
      async list() {
        return [record];
      },
      async update() {
        throw new Error("Unexpected mutation");
      },
    },
  });
  try {
    const read = () =>
      rpc.request("tools/call", { name: "fitia-gainer-carryover-get", arguments: { date: "2026-09-15" } });
    const missing = await read();
    expect(missing.result.isError).not.toBe(true);
    expect(JSON.parse(missing.result.content[0].text)).toMatchObject({
      verification: "diary_not_found",
      items: [{ id: plan.id, status: "pending" }],
    });
    status = 503;
    const unavailable = await read();
    expect(unavailable.result.isError).toBe(true);
    expect(JSON.parse(unavailable.result.content[0].text).error.code).toBe("DIARY_HTTP_ERROR");
  } finally {
    globalThis.fetch = previousFetch;
    await rpc.close();
  }
});
test("calculator calls the existing Fitia summary service once and never mutates the diary", async () => {
  const previousFetch = globalThis.fetch;
  let reads = 0;
  const fakeFetch: typeof fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user/dailyRecords/13-09-2026",
      );
      expect(init?.method ?? "GET").toBe("GET");
      reads++;
      return Response.json({
        name: "projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user/dailyRecords/13-09-2026",
        updateTime: "2026-09-13T20:00:00Z",
        fields: fields({
          mealProgress: {
            targetCalories: 2500,
            targetProteins: 150,
            targetCarbs: 320,
            targetFats: 80,
            consumedCalories: 2000,
            meals: {
              dinner: {
                typeID: 4,
                mealItems: {
                  eaten: {
                    type: "2",
                    name: "Synthetic",
                    isEaten: true,
                    calories: 2000,
                    proteins: 100,
                    carbs: 200,
                    fats: 50,
                  },
                },
              },
            },
          },
        }),
      });
    },
    { preconnect: previousFetch.preconnect },
  );
  globalThis.fetch = fakeFetch;
  const config = defaultGainerConfig();
  config.sweetenerInventory = "honey_only";
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`;
  const rpc = await client({
    token,
    trustedAccountId: "test-user",
    canWrite: false,
    gainerConfig: {
      async get() {
        return { config, version: "1", persisted: true };
      },
      async update() {
        throw new Error("Unexpected config write");
      },
    },
  });
  try {
    const result = (
      await rpc.request("tools/call", { name: "fitia-gainer-calculate", arguments: { date: "2026-09-13" } })
    ).result;
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data).toMatchObject({
      mode: "fitia_optimal",
      configVersion: "1",
      targetCaloriesKcal: 500,
      sweetener: { mode: "honey_only" },
      greenRanges: { caloriesKcal: { target: 2500, min: 2250, max: 2750 } },
      optimization: { scoringBasis: "practical_quantities", maxAdditionalCaloriesKcal: 750, practicalValidated: true },
    });
    expect(data.practicalNutrition.caloriesKcal).toBeLessThanOrEqual(750);
    expect(data.suggestedMealLog).toMatchObject(data.practicalNutrition);
    expect(data.optimization.score.after).toBeLessThan(data.optimization.score.before);
    expect(reads).toBe(1);
    expect(data.fitia.remaining).toEqual({ caloriesKcal: 500, proteinG: 50, carbsG: 120, fatG: 30 });
    const summary = JSON.parse(
      (await rpc.request("tools/call", { name: "fitia-day-summary", arguments: { date: "2026-09-13" } })).result
        .content[0].text,
    );
    expect(data.fitia).toEqual(summary);
    expect(reads).toBe(2);
  } finally {
    globalThis.fetch = previousFetch;
    await rpc.close();
  }
});

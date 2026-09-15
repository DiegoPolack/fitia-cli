import { expect, test } from "bun:test";
import { defaultGainerConfig } from "@fitia/core/gainer/recipe";
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
    const update = tools.find((t: any) => t.name === "fitia-gainer-config-update");
    expect(update.inputSchema.properties.confirm.default).toBe(false);
    expect(update.inputSchema.additionalProperties).toBe(false);
    expect(update._meta.securitySchemes[0].scopes).toEqual(["fitia:read", "fitia:write"]);
  } finally {
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

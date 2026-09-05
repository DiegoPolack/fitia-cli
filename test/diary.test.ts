import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiaryClient, type Fetch, type LogInput, validateDate, validateLog } from "@fitia/core";
import Ajv from "ajv";
import { schema } from "../apps/cli/src/contract/index.ts";
import { windowsPrivatePath } from "../packages/core/src/windows-permissions.ts";

const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.sig`;
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function v(input: any): any {
  if (typeof input === "string") return { stringValue: input };
  if (typeof input === "boolean") return { booleanValue: input };
  if (typeof input === "number") return { doubleValue: input };
  return { mapValue: { fields: Object.fromEntries(Object.entries(input).map(([k, value]) => [k, v(value)])) } };
}
function fixture() {
  return {
    name: "projects/fitia-27c84/databases/(default)/documents/Usuarios/verified-user/dailyRecords/30-08-2026",
    updateTime: "2026-08-30T10:00:00.000001Z",
    fields: v({
      unrelatedSetting: "preserve me",
      fcmToken: "synthetic-device-marker",
      mealProgress: {
        consumedCalories: 80,
        meals: {
          "breakfast.id": {
            typeID: 0,
            uid: "breakfast.id",
            mealItems: {
              existing: {
                type: "2",
                uniqueID: "existing",
                name: "Existing breakfast",
                isEaten: true,
                order: 0,
                calories: 80,
                proteins: 1,
                carbs: 9,
                fats: 4,
              },
            },
          },
          lunch: { typeID: 2, mealItems: {} },
        },
      },
    }).mapValue.fields,
  };
}
const input: LogInput = {
  date: "2026-08-30",
  meal: "breakfast",
  name: "Synthetic serving",
  caloriesKcal: 100,
  proteinG: 3,
  carbsG: 12,
  fatG: 4,
  idempotencyKey: "breakfast-example",
  dryRun: false,
  yes: true,
};
const refreshInput = { date: input.date, dryRun: false, yes: true };
function meals(doc: any) {
  return doc.fields.mealProgress.mapValue.fields.meals.mapValue.fields;
}
function items(doc: any) {
  return meals(doc)["breakfast.id"].mapValue.fields.mealItems.mapValue.fields;
}
async function harness(
  options: {
    status?: number;
    lostResponse?: boolean;
    badReadback?: boolean;
    changeBeforePatch?: boolean;
    ignoreDeletion?: boolean;
  } = {},
) {
  const state = await mkdtemp(join(tmpdir(), "fitia-diary-test-"));
  paths.push(state);
  const doc = fixture();
  meals(doc)["breakfast.id"].mapValue.fields.registrationDateUTC = { timestampValue: "2026-08-30T05:00:00Z" };
  let patches = 0,
    gets = 0;
  const calls: any[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("accounts:lookup"))
      return Response.json({ users: [{ localId: "verified-user", emailVerified: true }] });
    expect(url.startsWith("https://firestore.googleapis.com/")).toBe(true);
    expect(init.redirect).toBe("error");
    expect((init.headers as any).Authorization).toBe(`Bearer ${token}`);
    if (init.method === "PATCH") {
      patches++;
      const log = await readFile(join(state, (await readdir(state)).find((name) => name.endsWith(".jsonl"))!), "utf8");
      expect(JSON.parse(log.trim().split("\n").at(-1)!).status).toBe("pending");
      expect(log).not.toContain(token);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("currentDocument.updateTime")).toBe(doc.updateTime);
      const mask = parsed.searchParams.getAll("updateMask.fieldPaths");
      expect(mask.length).toBeGreaterThan(0);
      if (options.changeBeforePatch) return new Response("", { status: 412 });
      if (options.status) return new Response("do not expose upstream secrets", { status: options.status });
      const patch = JSON.parse(init.body as string);
      // Emulate Firestore's mask semantics, including omitted fields being deleted.
      for (const path of mask) {
        const segments = [...path.matchAll(/`((?:\\.|[^`])*)`|([^.]+)/g)].map((match) =>
          match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]!,
        );
        let destination = doc.fields,
          source: any = patch.fields;
        for (const segment of segments.slice(0, -1)) {
          destination = destination[segment].mapValue.fields;
          source = source?.[segment]?.mapValue?.fields;
        }
        const key = segments.at(-1)!;
        if (source && Object.hasOwn(source, key)) destination[key] = source[key];
        else if (!options.ignoreDeletion) delete destination[key];
      }
      doc.updateTime = `2026-08-30T10:00:${String(patches).padStart(2, "0")}.000001Z`;
      if (options.lostResponse) throw new Error("secret must not leak");
      return Response.json(doc);
    }
    gets++;
    if (options.badReadback && gets > 1) return new Response("", { status: 503 });
    return Response.json(doc);
  };
  const client = new DiaryClient(token, 1000, fetcher, state);
  return { client, state, calls, fetcher, document: () => doc, patches: () => patches };
}
function conforms(name: string, data: any) {
  const ajv = new Ajv({ strict: false, allowUnionTypes: true });
  const validate = ajv.compile(schema().commands.find((command) => command.name === name)!.data);
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
}

test("diary read preserves food names but does not present base-unit nutrition as totals", async () => {
  const h = await harness();
  items(h.document()).food = v({ name: "Food database entry", type: "0", isEaten: true, calories: 1.2 });
  const result = await h.client.get(input.date);
  conforms("meal get", result);
  expect(result.meals[0]!.items[1]!.caloriesKcal).toBeNull();
  expect(result.meals[0]!.items[0]!.caloriesKcal).toBe(80);
});
test("dry run uses real validation and reads but creates no write or audit", async () => {
  const h = await harness();
  const result = await h.client.log({ ...input, dryRun: true, yes: false });
  conforms("meal log", result);
  expect(result.status).toBe("preview");
  expect(h.patches()).toBe(0);
  expect(await readdir(h.state)).toEqual([]);
  expect(h.calls.length).toBe(2);
});
test("commit preserves unrelated entries, writes audit before request, and verifies readback", async () => {
  const h = await harness(),
    before = structuredClone(h.document());
  const result = await h.client.log(input);
  conforms("meal log", result);
  expect(result.status).toBe("committed");
  expect(result.serverVerified).toBe(true);
  expect(result.mobileVerified).toBe(false);
  expect(items(h.document()).existing).toEqual(items(before).existing);
  expect(meals(h.document()).lunch).toEqual(meals(before).lunch);
  expect(h.document().fields.unrelatedSetting).toEqual(before.fields.unrelatedSetting);
  expect(Object.keys(items(h.document()))).toHaveLength(2);
  const file = join(h.state, (await readdir(h.state)).find((n) => n.endsWith(".jsonl"))!);
  const records = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((r) => r.status)).toEqual(["pending", "committed"]);
  expect(records[0].attempt).toBe(records[1].attempt);
  if (process.platform === "win32") expect(await windowsPrivatePath(file)).toBe(true);
  else expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await h.client.log(input)).status).toBe("already-present");
  expect(h.patches()).toBe(1);
  await expect(h.client.log({ ...input, caloriesKcal: 200 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
test("logging derives a stable key and occurrence distinguishes identical entries", async () => {
  const h = await harness();
  const automatic = { ...input, idempotencyKey: undefined };
  const first = await h.client.log(automatic);
  expect(first.idempotencyKey).toMatch(/^auto:[a-f0-9]{64}$/);
  expect((await h.client.log(automatic)).status).toBe("already-present");
  const second = await h.client.log({ ...automatic, occurrence: 2 });
  expect(second.itemId).not.toBe(first.itemId);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(h.patches()).toBe(2);
});

test("a trusted saved-session account id skips identity lookup", async () => {
  const h = await harness();
  const trusted = new DiaryClient(
    token,
    1000,
    async (url, init) => {
      if (url.includes("accounts:lookup")) throw new Error("identity lookup should be skipped");
      return h.fetcher(url, init);
    },
    h.state,
    "verified-user",
  );
  expect((await trusted.log({ ...input, dryRun: true, yes: false })).status).toBe("preview");
});
test("logging clears the old device marker atomically so mobile does not discard the remote change", async () => {
  const h = await harness();
  const result = await h.client.log(input);
  const call = h.calls.find((call) => call.init.method === "PATCH");
  const mask = new URL(call.url).searchParams.getAll("updateMask.fieldPaths");
  expect(mask).toEqual([
    `mealProgress.meals.\`breakfast.id\`.mealItems.\`${result.itemId}\``,
    "mealProgress.consumedCalories",
    "fcmToken",
  ]);
  expect(JSON.parse(call.init.body).fields.fcmToken).toEqual({ nullValue: null });
  expect(result.fieldsChanged).toEqual(mask);
  const audit = await readFile(join(h.state, (await readdir(h.state)).find((n) => n.endsWith(".jsonl"))!), "utf8");
  expect(audit).not.toContain("synthetic-device-marker");
});
test("refresh previews the real marker update without touching meals or creating local state", async () => {
  const h = await harness(),
    before = structuredClone(h.document());
  const result = await h.client.refresh({ ...refreshInput, dryRun: true, yes: false });
  conforms("meal refresh", result);
  expect(result.status).toBe("preview");
  expect(result.fieldsChanged).toEqual(["fcmToken"]);
  expect(h.document()).toEqual(before);
  expect(h.patches()).toBe(0);
  expect(await readdir(h.state)).toEqual([]);
});
test("refresh patches only the origin marker with a precondition, audits, and repeats without another write", async () => {
  const h = await harness(),
    before = structuredClone(h.document());
  const result = await h.client.refresh(refreshInput);
  conforms("meal refresh", result);
  expect(result.status).toBe("committed");
  expect(result.serverVerified).toBe(true);
  expect(result.mobileVerified).toBe(false);
  const call = h.calls.find((call) => call.init.method === "PATCH");
  expect(new URL(call.url).searchParams.getAll("updateMask.fieldPaths")).toEqual(["fcmToken"]);
  expect(JSON.parse(call.init.body)).toEqual({ fields: { fcmToken: { nullValue: null } } });
  expect(h.document().fields).toEqual({ ...before.fields, fcmToken: { nullValue: null } });
  const again = await h.client.refresh(refreshInput);
  conforms("meal refresh", again);
  expect(again.status).toBe("already-requested");
  expect(again.fieldsChanged).toEqual([]);
  expect(h.patches()).toBe(1);
  const audit = await readFile(join(h.state, (await readdir(h.state)).find((n) => n.endsWith(".jsonl"))!), "utf8");
  const records = audit
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((r) => r.status)).toEqual(["pending", "committed"]);
  expect(records[0].attempt).toBe(records[1].attempt);
  expect(audit).not.toContain("synthetic-device-marker");
  expect(audit).not.toContain(token);
});
test("refresh requires explicit consent and obeys the write killswitch", async () => {
  const h = await harness();
  await expect(h.client.refresh({ ...refreshInput, yes: false })).rejects.toMatchObject({
    code: "WRITE_CONFIRMATION_REQUIRED",
  });
  await expect(h.client.refresh({ ...refreshInput, dryRun: true })).rejects.toMatchObject({
    code: "CONFLICTING_OPTIONS",
  });
  expect(h.calls).toEqual([]);
  await writeFile(join(h.state, "DISABLE_WRITES"), "");
  await expect(h.client.refresh(refreshInput)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(h.calls).toEqual([]);
  expect((await h.client.refresh({ ...refreshInput, dryRun: true, yes: false })).status).toBe("preview");
});
test("refresh does not overwrite a concurrent diary edit or automatically retry", async () => {
  const h = await harness({ changeBeforePatch: true }),
    before = structuredClone(h.document());
  await expect(h.client.refresh(refreshInput)).rejects.toMatchObject({ code: "DIARY_CHANGED" });
  expect(h.document()).toEqual(before);
  expect(h.patches()).toBe(1);
  expect((await readdir(h.state)).some((n) => n.endsWith(".lock"))).toBe(false);
});
test("an uncertain refresh can be checked again without rewriting meals", async () => {
  const h = await harness({ lostResponse: true });
  await expect(h.client.refresh(refreshInput)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
  expect((await h.client.refresh(refreshInput)).status).toBe("already-requested");
  expect(h.patches()).toBe(1);
});
test("refresh cannot claim success when readback fails", async () => {
  const h = await harness({ badReadback: true });
  await expect(h.client.refresh(refreshInput)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
});
const removeInput = { date: input.date, meal: "breakfast" as const, itemId: "existing", dryRun: false, yes: true };
test("remove previews the exact entry and calorie change with no mutation or audit", async () => {
  const h = await harness(),
    before = structuredClone(h.document());
  const result = await h.client.remove({ ...removeInput, dryRun: true, yes: false });
  conforms("meal remove", result);
  expect(result.status).toBe("preview");
  expect(result.entry?.name).toBe("Existing breakfast");
  expect(result.caloriesRemovedKcal).toBe(80);
  expect(result.consumedCaloriesBeforeKcal).toBe(80);
  expect(result.consumedCaloriesAfterKcal).toBe(0);
  expect(h.document()).toEqual(before);
  expect(h.patches()).toBe(0);
  expect(await readdir(h.state)).toEqual([]);
});
test("remove deletes one map field, updates totals and mobile marker atomically, and audits its entry first", async () => {
  const h = await harness();
  items(h.document()).keep = v({ type: "0", uniqueID: "keep", name: "Keep this food", isEaten: false, calories: 1.2 });
  const before = structuredClone(h.document());
  const result = await h.client.remove(removeInput);
  conforms("meal remove", result);
  expect(result.status).toBe("committed");
  expect(result.serverVerified).toBe(true);
  expect(result.mobileVerified).toBe(false);
  expect(Object.hasOwn(items(h.document()), "existing")).toBe(false);
  expect(items(h.document()).keep).toEqual(items(before).keep);
  expect(meals(h.document()).lunch).toEqual(meals(before).lunch);
  expect(h.document().fields.unrelatedSetting).toEqual(before.fields.unrelatedSetting);
  const call = h.calls.find((call) => call.init.method === "PATCH");
  expect(new URL(call.url).searchParams.getAll("updateMask.fieldPaths")).toEqual([
    "mealProgress.meals.`breakfast.id`.mealItems.`existing`",
    "mealProgress.consumedCalories",
    "fcmToken",
  ]);
  expect(JSON.parse(call.init.body)).toEqual({
    fields: {
      mealProgress: { mapValue: { fields: { consumedCalories: { doubleValue: 0 } } } },
      fcmToken: { nullValue: null },
    },
  });
  const records = (await readFile(join(h.state, (await readdir(h.state)).find((n) => n.endsWith(".jsonl"))!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((r) => r.status)).toEqual(["pending", "committed"]);
  expect(records[0].attempt).toBe(records[1].attempt);
  expect(records[0].entry).toMatchObject({
    name: "Existing breakfast",
    caloriesKcal: 80,
    proteinG: 1,
    carbsG: 9,
    fatG: 4,
  });
});
test("removing a planned quick entry does not subtract consumed calories", async () => {
  const h = await harness();
  items(h.document()).existing.mapValue.fields.isEaten = { booleanValue: false };
  const result = await h.client.remove(removeInput);
  expect(result.caloriesRemovedKcal).toBe(0);
  expect(result.consumedCaloriesAfterKcal).toBe(80);
  expect(Object.keys(items(h.document()))).toEqual([]);
});
test("repeated removal cannot subtract calories twice and absent entries need no write", async () => {
  const h = await harness();
  await h.client.remove(removeInput);
  const result = await h.client.remove(removeInput);
  conforms("meal remove", result);
  expect(result.status).toBe("already-absent");
  expect(result.entry).toBeNull();
  expect(result.caloriesRemovedKcal).toBe(0);
  expect(result.fieldsChanged).toEqual([]);
  expect(h.patches()).toBe(1);
  expect((await h.client.remove({ ...removeInput, itemId: "constructor" })).status).toBe("already-absent");
});
test.each(["0", "1", "future"])("removal refuses unverified entry type %s", async (type) => {
  const h = await harness();
  items(h.document()).existing.mapValue.fields.type = { stringValue: type };
  await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "UNSUPPORTED_ENTRY_TYPE" });
  expect(h.patches()).toBe(0);
});
test("removal fails closed on missing or inconsistent calorie accounting", async () => {
  for (const [mutation, code] of [
    [
      (h: any) => {
        delete items(h.document()).existing.mapValue.fields.calories;
      },
      "INVALID_RESPONSE",
    ],
    [
      (h: any) => {
        delete items(h.document()).existing.mapValue.fields.isEaten;
      },
      "INVALID_RESPONSE",
    ],
    [
      (h: any) => {
        h.document().fields.mealProgress.mapValue.fields.consumedCalories = { doubleValue: 50 };
      },
      "DIARY_TOTAL_CONFLICT",
    ],
  ] as const) {
    const h = await harness();
    mutation(h);
    await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code });
    expect(h.patches()).toBe(0);
  }
});
test("removal clamps only negligible negative floating point remainder", async () => {
  const h = await harness();
  h.document().fields.mealProgress.mapValue.fields.consumedCalories = { doubleValue: 79.99999999999999 };
  expect((await h.client.remove(removeInput)).consumedCaloriesAfterKcal).toBe(0);
});
test("removal treats dots in IDs as field names rather than path separators", async () => {
  const h = await harness();
  items(h.document())["target.with.dots"] = items(h.document()).existing;
  delete items(h.document()).existing;
  expect((await h.client.remove({ ...removeInput, itemId: "target.with.dots" })).status).toBe("committed");
  expect(Object.keys(items(h.document()))).toEqual([]);
});
test("removal validates the target and consent before any network access", async () => {
  const h = await harness();
  for (const [patch, code] of [
    [{ yes: false }, "WRITE_CONFIRMATION_REQUIRED"],
    [{ dryRun: true }, "CONFLICTING_OPTIONS"],
    [{ itemId: "" }, "INVALID_ITEM_ID"],
    [{ itemId: "*" }, "INVALID_ITEM_ID"],
    [{ itemId: "../x" }, "INVALID_ITEM_ID"],
    [{ itemId: "a\nb" }, "INVALID_ITEM_ID"],
    [{ meal: "snack" }, "INVALID_MEAL"],
    [{ date: "2026-02-30" }, "INVALID_DATE"],
  ] as const) {
    await expect(h.client.remove({ ...removeInput, ...patch } as any)).rejects.toMatchObject({ code });
  }
  expect(h.calls).toEqual([]);
});
test("removal obeys killswitch and requires a unique existing meal container", async () => {
  const h = await harness();
  await writeFile(join(h.state, "DISABLE_WRITES"), "");
  await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(h.calls).toEqual([]);
  expect((await h.client.remove({ ...removeInput, dryRun: true, yes: false })).status).toBe("preview");
  await rm(join(h.state, "DISABLE_WRITES"));
  delete meals(h.document())["breakfast.id"];
  await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "MEAL_NOT_FOUND" });
  expect(h.patches()).toBe(0);
});
test("concurrent changes are never overwritten by removal", async () => {
  const h = await harness({ changeBeforePatch: true }),
    before = structuredClone(h.document());
  await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "DIARY_CHANGED" });
  expect(h.document()).toEqual(before);
  expect(h.patches()).toBe(1);
});
test("a lost removal response is uncertain and retry verifies absence without another write", async () => {
  const h = await harness({ lostResponse: true });
  await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
  expect((await h.client.remove(removeInput)).status).toBe("already-absent");
  expect(h.patches()).toBe(1);
});
test.each([{ badReadback: true }, { ignoreDeletion: true }])(
  "removal requires readback proof that the entry is absent",
  async (options) => {
    const h = await harness(options);
    await expect(h.client.remove(removeInput)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
  },
);
test("parallel removal cannot subtract calories twice", async () => {
  const h = await harness();
  const results = await Promise.allSettled([h.client.remove(removeInput), h.client.remove(removeInput)]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(h.patches()).toBe(1);
});
test("a lost response is uncertain and repeating the same key discovers the committed entry", async () => {
  const h = await harness({ lostResponse: true });
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
  expect((await h.client.log(input)).status).toBe("already-present");
  expect(h.patches()).toBe(1);
});
test("a concurrent diary change is rejected without overwriting and permits a same-key retry", async () => {
  const h = await harness({ changeBeforePatch: true });
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "DIARY_CHANGED" });
  expect(Object.keys(items(h.document()))).toEqual(["existing"]);
  expect((await readdir(h.state)).some((n) => n.endsWith(".lock"))).toBe(false);
});
test("post-write readback failure never reports success", async () => {
  const h = await harness({ badReadback: true });
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
});
test("kill switch blocks writes before any service call, but allows previews", async () => {
  const h = await harness();
  await writeFile(join(h.state, "DISABLE_WRITES"), "");
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(h.calls).toEqual([]);
  expect((await h.client.log({ ...input, dryRun: true, yes: false })).status).toBe("preview");
});
test("missing day or meal is not invented", async () => {
  const h = await harness();
  delete meals(h.document())["breakfast.id"];
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "MEAL_NOT_FOUND" });
  expect(h.patches()).toBe(0);
});
test("parallel attempts with the same key cannot create duplicate entries", async () => {
  const h = await harness();
  const results = await Promise.allSettled([h.client.log(input), h.client.log(input)]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(h.patches()).toBe(1);
  expect(Object.keys(items(h.document()))).toHaveLength(2);
});
test("unsafe audit permissions prevent the remote write", async () => {
  const h = await harness();
  const path = join(h.state, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await writeFile(path, "", { mode: 0o644 });
  if (process.platform === "win32") {
    const result = Bun.spawnSync(["icacls.exe", path, "/grant", "*S-1-1-0:(R)"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    expect(result.exitCode).toBe(0);
  }
  await expect(h.client.log(input)).rejects.toMatchObject({ code: "UNSAFE_AUDIT_LOG" });
  expect(h.patches()).toBe(0);
});
test.each(["2026-02-30", "2026-13-01", "2026-08-30T00:00:00Z", "../x", ""])("invalid date %s is rejected", (date) => {
  expect(() => validateDate(date)).toThrow();
});
test("explicit flags and all amounts are required", () => {
  for (const patch of [
    { yes: false },
    { dryRun: true },
    { caloriesKcal: NaN },
    { fatG: -1 },
    { idempotencyKey: "../secret" },
    { occurrence: 0 },
    { meal: "supper" },
  ]) {
    expect(() => validateLog({ ...input, ...patch } as LogInput)).toThrow();
  }
});

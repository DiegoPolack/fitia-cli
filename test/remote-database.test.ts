import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { defaultGainerConfig } from "@fitia/core/gainer/recipe";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { decryptJson, importEncryptionKey, randomCode } from "../apps/mcp/src/remote/crypto.ts";
import { GainerCarryoverRepository } from "../apps/mcp/src/remote/gainer-carryover.ts";
import { GainerConfigRepository } from "../apps/mcp/src/remote/gainer-config.ts";
import { remoteWriteJournal } from "../apps/mcp/src/remote/journal.ts";
import { type DatabaseRunner, type FitiaSession, SessionRepository } from "../apps/mcp/src/remote/sessions.ts";

const db = new PGlite();
const database: DatabaseRunner = {
  run: async (use) =>
    use({
      query: async <Row>(sql: string, parameters: unknown[] = []) => {
        const result = await db.query<Row>(sql, parameters);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    }),
};
const key = await importEncryptionKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
const session: FitiaSession = {
  idToken: `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`,
  refreshToken: "synthetic-only",
  uid: "fitia-test",
  email: null,
};
const repository = new SessionRepository(
  "unused",
  key,
  database,
  async (saved) => saved,
  async () => "fitia-test",
  async () => {},
);

beforeAll(async () => {
  await db.waitReady;
  for (const file of ["0000_large_katie_power.sql", "0001_noisy_boom_boom.sql"]) {
    await db.exec(await readFile(new URL(`../apps/mcp/migrations/${file}`, import.meta.url), "utf8"));
  }
  const ownerCode = randomCode();
  await repository.createLinkCode("user_3Itb8UB0Xm4qf8UQVt5UdW3TNdw", ownerCode);
  await repository.consumeLinkCode(ownerCode, session);
  await db.exec(await readFile(new URL("../apps/mcp/migrations/0002_thick_praxagora.sql", import.meta.url), "utf8"));
  await db.exec(
    await readFile(new URL("../apps/mcp/migrations/0003_groovy_madame_masque.sql", import.meta.url), "utf8"),
  );
}, 30000);
afterAll(async () => {
  await db.close();
});

function configRepository(user: string, disabled = false, runner = database) {
  return new GainerConfigRepository({
    databaseUrl: "unused",
    clerkUserId: user,
    database: runner,
    journal: remoteWriteJournal({
      databaseUrl: "unused",
      clerkUserId: user,
      fitiaAccountId: session.uid,
      key,
      disabled,
      database,
    }),
  });
}

function carryRepository(user: string, disabled = false, runner = database) {
  return new GainerCarryoverRepository({
    databaseUrl: "unused",
    clerkUserId: user,
    database: runner,
    journal: remoteWriteJournal({
      databaseUrl: "unused",
      clerkUserId: user,
      fitiaAccountId: session.uid,
      key,
      disabled,
      database,
    }),
  });
}
const carryPlan = makeCarryoverPlan(
  {
    sourceDate: "2026-09-14",
    recipeId: "polack_labs_mass_gainer_v1",
    scaleFactor: 1.47,
    sweetener: "honey_only",
    nightPercent: 68,
  },
  defaultGainerConfig(),
);
const noEntry = async () => null;
const matchingEntry = async () => ({ meal: "breakfast" as const, itemId: "verified-synthetic-entry" });

test("carryover save is preview-first, isolated, idempotent and audited using the existing journal", async () => {
  const store = carryRepository("carry-owner");
  const preview = await store.update({ action: "save", plan: carryPlan, confirm: false }, noEntry);
  expect(preview).toMatchObject({ status: "preview", expectedVersion: "0", after: { status: "pending" } });
  expect(await store.list("2026-09-15")).toEqual([]);
  await expect(store.update({ action: "save", plan: carryPlan, confirm: true }, noEntry)).rejects.toThrow(
    "preview version",
  );
  expect(
    await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
  ).toMatchObject({ status: "committed" });
  expect(
    await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
  ).toMatchObject({ status: "already-present" });
  expect(await store.list("2026-09-15")).toHaveLength(1);
  expect(await carryRepository("carry-other").list("2026-09-15")).toHaveLength(0);
  await expect(
    carryRepository("carry-other").update({ action: "cancelled", carryoverId: carryPlan.id, confirm: false }, noEntry),
  ).rejects.toThrow("not found");
  const audit = await db.query<{ id: string; ciphertext: Uint8Array; iv: Uint8Array }>(
    "SELECT id,ciphertext,iv FROM fitia_write_audit WHERE clerk_user_id='carry-owner' ORDER BY created_at",
  );
  expect(audit.rows).toHaveLength(2);
  const first = audit.rows[0]!;
  expect(
    await decryptJson(key, first.ciphertext, first.iv, `audit:carry-owner:${session.uid}:${first.id}`),
  ).toMatchObject({ phase: "before-write", after: { status: "pending", nutrition: carryPlan.nutrition } });
});

test("carryover consumption verifies Fitia, requires a current version, and retries without duplicating", async () => {
  const store = carryRepository("carry-consumer");
  await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry);
  await expect(
    store.update({ action: "consumed", carryoverId: carryPlan.id, confirm: false }, noEntry),
  ).rejects.toThrow("No matching");
  const preview = await store.update({ action: "consumed", carryoverId: carryPlan.id, confirm: false }, matchingEntry);
  expect(preview).toMatchObject({ expectedVersion: "1", after: { status: "consumed", version: "2" } });
  expect((await store.list("2026-09-15"))[0]!.status).toBe("pending");
  await expect(
    store.update({ action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "0" }, matchingEntry),
  ).rejects.toThrow("preview version");
  await store.update(
    { action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" },
    matchingEntry,
  );
  expect(
    await store.update(
      { action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" },
      matchingEntry,
    ),
  ).toMatchObject({ status: "already-present" });
  expect((await store.list("2026-09-15"))[0]).toMatchObject({
    status: "consumed",
    version: "2",
    consumedEntry: await matchingEntry(),
  });
  await expect(
    store.update({ action: "cancelled", carryoverId: carryPlan.id, confirm: true, expectedVersion: "2" }, noEntry),
  ).rejects.toThrow("cannot change");
});

test("carryover cancellation is preview-first and cannot cancel an already registered portion", async () => {
  const store = carryRepository("carry-cancel");
  await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry);
  await expect(
    store.update({ action: "cancelled", carryoverId: carryPlan.id, confirm: false }, matchingEntry),
  ).rejects.toThrow("already registered");
  expect(await store.update({ action: "cancelled", carryoverId: carryPlan.id, confirm: false }, noEntry)).toMatchObject(
    { status: "preview" },
  );
  expect((await store.list("2026-09-15"))[0]!.status).toBe("pending");
  await store.update({ action: "cancelled", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" }, noEntry);
  expect((await store.list("2026-09-15"))[0]!.status).toBe("cancelled");
  expect(
    await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
  ).toMatchObject({ status: "already-present", after: { status: "cancelled" } });
});

test("carryover kill switch and pre-write diary recheck prevent changes", async () => {
  const disabled = carryRepository("carry-disabled", true);
  expect(await disabled.update({ action: "save", plan: carryPlan, confirm: false }, noEntry)).toMatchObject({
    status: "preview",
  });
  await expect(
    disabled.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
  ).rejects.toThrow("disabled");
  expect(await disabled.list("2026-09-15")).toEqual([]);
  const store = carryRepository("carry-race");
  await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry);
  let reads = 0;
  await expect(
    store.update({ action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" }, async () =>
      ++reads === 1 ? matchingEntry() : null,
    ),
  ).rejects.toThrow("changed before");
  expect((await store.list("2026-09-15"))[0]!.status).toBe("pending");
});

test("new night config defaults are backward compatible and patches validate the merged version", async () => {
  const store = configRepository("night-config");
  expect((await store.get()).config).toMatchObject({ preferredNightCaloriesKcal: 700, maxNightCaloriesKcal: 750 });
  await expect(store.update({ preferredNightCaloriesKcal: 800 }, false)).rejects.toThrow("cannot exceed");
  expect(await store.update({ preferredNightCaloriesKcal: 600, maxNightCaloriesKcal: 650 }, false)).toMatchObject({
    expectedVersion: "0",
  });
  expect((await store.get()).config.maxNightCaloriesKcal).toBe(750);
  await store.update({ preferredNightCaloriesKcal: 600, maxNightCaloriesKcal: 650 }, true, "0");
  expect(await store.get()).toMatchObject({
    version: "1",
    config: { preferredNightCaloriesKcal: 600, maxNightCaloriesKcal: 650 },
  });
});

test("concurrent carryover saves/transitions have one winner and retain their preview version", async () => {
  const a = carryRepository("carry-concurrent"),
    b = carryRepository("carry-concurrent");
  const saved = await Promise.allSettled([
    a.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
    b.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry),
  ]);
  expect(saved.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const changed = await Promise.allSettled([
    a.update({ action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" }, matchingEntry),
    b.update({ action: "cancelled", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" }, noEntry),
  ]);
  expect(changed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await a.list("2026-09-15"))[0]!.version).toBe("2");
});

test("corrupt carryover snapshots fail rather than disappearing or using defaults", async () => {
  const store = carryRepository("carry-corrupt");
  await store.update({ action: "save", plan: carryPlan, confirm: true, expectedVersion: "0" }, noEntry);
  await db.query("UPDATE fitia_gainer_carryover SET definition = '{}'::jsonb WHERE clerk_user_id = 'carry-corrupt'");
  await expect(store.list("2026-09-15")).rejects.toThrow();
});

test("one Fitia receipt cannot consume two carryovers; a rejected reference leaves no uncertain lock", async () => {
  const store = carryRepository("carry-unique-entry");
  const other = makeCarryoverPlan({ ...carryPlan.definition.draft, nightPercent: 67 }, defaultGainerConfig());
  for (const plan of [carryPlan, other])
    await store.update({ action: "save", plan, confirm: true, expectedVersion: "0" }, noEntry);
  await store.update(
    { action: "consumed", carryoverId: carryPlan.id, confirm: true, expectedVersion: "1" },
    matchingEntry,
  );
  await expect(
    store.update({ action: "consumed", carryoverId: other.id, confirm: true, expectedVersion: "1" }, matchingEntry),
  ).rejects.toThrow("already assigned");
  expect(
    (await db.query("SELECT * FROM fitia_write_locks WHERE clerk_user_id='carry-unique-entry'")).rows,
  ).toHaveLength(0);
  expect((await store.list("2026-09-15")).find((r) => r.id === other.id)!.status).toBe("pending");
});
test("gainer migration seeds only the verified owner; config reads and previews never write", async () => {
  expect((await configRepository("user_3Itb8UB0Xm4qf8UQVt5UdW3TNdw").get()).config.sweetenerInventory).toBe(
    "honey_only",
  );
  const store = configRepository("user_gainer_new");
  expect(await store.get()).toMatchObject({
    persisted: false,
    version: "0",
    config: { sweetenerInventory: "unknown" },
  });
  const before = await db.query("SELECT * FROM fitia_gainer_config");
  const auditBefore = await db.query("SELECT * FROM fitia_write_audit");
  const preview = await store.update({ sweetenerInventory: "both" }, false);
  expect(preview).toMatchObject({
    status: "preview",
    before: { sweetenerInventory: "unknown" },
    after: { sweetenerInventory: "both" },
    expectedVersion: "0",
  });
  expect((await db.query("SELECT * FROM fitia_gainer_config")).rows).toEqual(before.rows);
  expect((await db.query("SELECT * FROM fitia_write_audit")).rows).toEqual(auditBefore.rows);
});
test("confirmed gainer config uses CAS, existing encrypted journal, readback and user isolation", async () => {
  const store = configRepository("user_gainer_write");
  await expect(store.update({ sweetenerInventory: "both" }, true)).rejects.toThrow("preview version");
  await store.update({ sweetenerInventory: "both" }, false);
  const result = await store.update({ sweetenerInventory: "both" }, true, "0");
  expect(result).toMatchObject({ status: "committed", serverVerified: true });
  expect((await store.get()).config.sweetenerInventory).toBe("both");
  expect((await configRepository("user_other").get()).config.sweetenerInventory).toBe("unknown");
  await expect(store.update({ sweetenerInventory: "none" }, true, "0")).rejects.toThrow("preview version");
  const audits = await db.query<{ id: string; ciphertext: Uint8Array; iv: Uint8Array }>(
    "SELECT id, ciphertext, iv FROM fitia_write_audit WHERE clerk_user_id = 'user_gainer_write' ORDER BY created_at",
  );
  expect(audits.rows).toHaveLength(2);
  const decoded = await decryptJson(
    key,
    audits.rows[0]!.ciphertext,
    audits.rows[0]!.iv,
    `audit:user_gainer_write:${session.uid}:${audits.rows[0]!.id}`,
  );
  expect(decoded).toMatchObject({ status: "pending", phase: "before-write", after: { sweetenerInventory: "both" } });
  const locks = await db.query("SELECT * FROM fitia_write_locks WHERE clerk_user_id = 'user_gainer_write'");
  expect(locks.rows).toHaveLength(0);
});
test("gainer kill switch permits previews but blocks confirmed settings", async () => {
  const store = configRepository("user_gainer_disabled", true);
  expect(await store.update({ sweetenerInventory: "none" }, false)).toMatchObject({ status: "preview" });
  await expect(store.update({ sweetenerInventory: "none" }, true, "0")).rejects.toThrow("disabled");
  expect((await store.get()).persisted).toBe(false);
});
test("gainer rejects invalid persisted config and empty patches instead of defaulting", async () => {
  await db.query("INSERT INTO fitia_gainer_config (clerk_user_id, config) VALUES ($1,$2::jsonb)", [
    "user_corrupt",
    JSON.stringify({ sweetenerInventory: "bad" }),
  ]);
  await expect(configRepository("user_corrupt").get()).rejects.toThrow();
  await expect(configRepository("user_other").update({}, false)).rejects.toThrow("No configuration");
});
test("gainer concurrent updates cannot overwrite the winning preview", async () => {
  const a = configRepository("user_gainer_race"),
    b = configRepository("user_gainer_race");
  const results = await Promise.allSettled([
    a.update({ sweetenerInventory: "both" }, true, "0"),
    b.update({ sweetenerInventory: "none" }, true, "0"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await a.get()).version).toBe("1");
});

test("PostgreSQL atomically consumes a link once and isolates users", async () => {
  const code = randomCode();
  await repository.createLinkCode("user_owner", code);
  const results = await Promise.allSettled([
    repository.consumeLinkCode(code, session),
    repository.consumeLinkCode(code, session),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await repository.load("user_owner")).toEqual(session);
  expect(await repository.load("user_other")).toBeUndefined();
  await expect(repository.consumeLinkCode(code, session)).rejects.toThrow("invalid or expired");
  const stored = await db.query<{ ciphertext: Uint8Array }>(
    "SELECT ciphertext FROM fitia_sessions WHERE clerk_user_id = 'user_owner'",
  );
  expect(Buffer.from(stored.rows[0]!.ciphertext).includes(Buffer.from(session.refreshToken))).toBe(false);
});

test("expired and superseded codes cannot link accounts", async () => {
  const expired = randomCode();
  await repository.createLinkCode("user_expired", expired);
  await db.exec(
    "UPDATE fitia_link_codes SET expires_at = now() - interval '1 second' WHERE clerk_user_id = 'user_expired'",
  );
  await expect(repository.consumeLinkCode(expired, session)).rejects.toThrow("invalid or expired");
  const replacement = randomCode();
  await repository.createLinkCode("user_expired", replacement);
  await repository.consumeLinkCode(replacement, session);
  const old = randomCode(),
    next = randomCode();
  await repository.createLinkCode("user_replaced", old);
  await repository.createLinkCode("user_replaced", next);
  await expect(repository.consumeLinkCode(old, session)).rejects.toThrow("invalid or expired");
  await repository.consumeLinkCode(next, session);
});

test("identity verification failures do not consume the link", async () => {
  const code = randomCode();
  await repository.createLinkCode("user_mismatch", code);
  await expect(repository.consumeLinkCode(code, { ...session, uid: "other" })).rejects.toThrow("verification failed");
  await repository.consumeLinkCode(code, session);
});

test("durable write locks exclude duplicate attempts and audit records are encrypted", async () => {
  const options = {
    databaseUrl: "unused",
    clerkUserId: "user_journal",
    fitiaAccountId: session.uid,
    key,
    disabled: false,
    database,
  };
  const first = remoteWriteJournal(options),
    second = remoteWriteJournal(options);
  await first.acquire("hash");
  await expect(second.acquire("hash")).rejects.toThrow("pending");
  await second.release("hash");
  await expect(second.acquire("hash")).rejects.toThrow("pending");
  await first.audit({ status: "pending", name: "private synthetic meal" });
  const result = await db.query<{ ciphertext: Uint8Array }>(
    "SELECT ciphertext FROM fitia_write_audit WHERE clerk_user_id = 'user_journal'",
  );
  expect(result.rows).toHaveLength(1);
  expect(Buffer.from(result.rows[0]!.ciphertext).includes(Buffer.from("private synthetic meal"))).toBe(false);
  await first.release("hash");
  await second.acquire("hash");
  expect(await remoteWriteJournal({ ...options, disabled: true }).disabled()).toBe(true);
});

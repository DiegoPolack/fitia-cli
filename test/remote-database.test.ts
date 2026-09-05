import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { importEncryptionKey, randomCode } from "../apps/mcp/src/remote/crypto.ts";
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
}, 30000);
afterAll(async () => {
  await db.close();
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
  const result = await db.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM fitia_write_audit");
  expect(result.rows).toHaveLength(1);
  expect(Buffer.from(result.rows[0]!.ciphertext).includes(Buffer.from("private synthetic meal"))).toBe(false);
  await first.release("hash");
  await second.acquire("hash");
  expect(await remoteWriteJournal({ ...options, disabled: true }).disabled()).toBe(true);
});

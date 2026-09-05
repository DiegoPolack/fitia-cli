import type { WriteJournal } from "@fitia/core/safe-write";
import { bytesToBase64, encryptJson } from "./crypto.ts";
import { type DatabaseRunner, neonDatabase } from "./sessions.ts";

// Durable locks have no automatic expiry: an uncertain provider mutation must
// be reconciled against its exact diary/item before an operator releases it.
export function remoteWriteJournal(options: {
  databaseUrl: string;
  clerkUserId: string;
  fitiaAccountId: string;
  key: CryptoKey;
  disabled: boolean;
  database?: DatabaseRunner;
}): WriteJournal {
  const database = options.database ?? neonDatabase(options.databaseUrl);
  const query = (sql: string, parameters: unknown[]) => database.run((client) => client.query(sql, parameters));
  const attempts = new Map<string, string>();
  return {
    async disabled() {
      return options.disabled;
    },
    async acquire(hash) {
      const attempt = crypto.randomUUID();
      const result = await query(
        `INSERT INTO fitia_write_locks (clerk_user_id, operation_hash, attempt)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING attempt`,
        [options.clerkUserId, hash, attempt],
      );
      if (result.rowCount !== 1) throw new Error("Operation already pending");
      attempts.set(hash, attempt);
      return { async writeFile() {}, async sync() {}, async close() {} };
    },
    async release(hash) {
      await query("DELETE FROM fitia_write_locks WHERE clerk_user_id = $1 AND operation_hash = $2 AND attempt = $3", [
        options.clerkUserId,
        hash,
        attempts.get(hash),
      ]);
      attempts.delete(hash);
    },
    async audit(record) {
      const id = crypto.randomUUID();
      const encrypted = await encryptJson(
        options.key,
        record,
        `audit:${options.clerkUserId}:${options.fitiaAccountId}:${id}`,
      );
      await query(
        `INSERT INTO fitia_write_audit (id, clerk_user_id, fitia_account_id, ciphertext, iv)
         VALUES ($1, $2, $3, decode($4, 'base64'), decode($5, 'base64'))`,
        [
          id,
          options.clerkUserId,
          options.fitiaAccountId,
          bytesToBase64(encrypted.ciphertext),
          bytesToBase64(encrypted.iv),
        ],
      );
    },
  };
}

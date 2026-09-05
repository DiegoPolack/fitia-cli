import { sql } from "drizzle-orm";
import { bigint, check, customType, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType: () => "bytea",
});

export const fitiaSessions = pgTable(
  "fitia_sessions",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    fitiaAccountId: text("fitia_account_id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("fitia_sessions_iv_length", sql`octet_length(${table.iv}) = 12`)],
);

export const fitiaLinkCodes = pgTable(
  "fitia_link_codes",
  {
    codeHash: bytea("code_hash").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("fitia_link_codes_hash_length", sql`octet_length(${table.codeHash}) = 32`),
    uniqueIndex("fitia_link_codes_user_idx").on(table.clerkUserId),
    index("fitia_link_codes_expiry_idx").on(table.expiresAt),
  ],
);

export const fitiaWriteLocks = pgTable(
  "fitia_write_locks",
  {
    clerkUserId: text("clerk_user_id").notNull(),
    operationHash: text("operation_hash").notNull(),
    attempt: text("attempt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("fitia_write_locks_operation_idx").on(table.clerkUserId, table.operationHash)],
);

export const fitiaWriteAudit = pgTable(
  "fitia_write_audit",
  {
    id: text("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    fitiaAccountId: text("fitia_account_id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("fitia_write_audit_iv_length", sql`octet_length(${table.iv}) = 12`)],
);

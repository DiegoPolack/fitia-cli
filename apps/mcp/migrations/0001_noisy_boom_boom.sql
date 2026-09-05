CREATE TABLE "fitia_write_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"fitia_account_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fitia_write_audit_iv_length" CHECK (octet_length("fitia_write_audit"."iv") = 12)
);
--> statement-breakpoint
CREATE TABLE "fitia_write_locks" (
	"clerk_user_id" text NOT NULL,
	"operation_hash" text NOT NULL,
	"attempt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fitia_write_locks_operation_idx" ON "fitia_write_locks" USING btree ("clerk_user_id","operation_hash");
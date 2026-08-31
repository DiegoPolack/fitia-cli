CREATE TABLE "fitia_link_codes" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fitia_link_codes_hash_length" CHECK (octet_length("fitia_link_codes"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "fitia_sessions" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"fitia_account_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fitia_sessions_iv_length" CHECK (octet_length("fitia_sessions"."iv") = 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fitia_link_codes_user_idx" ON "fitia_link_codes" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "fitia_link_codes_expiry_idx" ON "fitia_link_codes" USING btree ("expires_at");
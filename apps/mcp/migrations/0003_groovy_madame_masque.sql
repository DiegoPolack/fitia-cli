CREATE TABLE "fitia_gainer_carryover" (
	"clerk_user_id" text NOT NULL,
	"id" text NOT NULL,
	"source_date" text NOT NULL,
	"target_date" text NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"consumed_meal" text,
	"consumed_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fitia_gainer_carryover_clerk_user_id_id_pk" PRIMARY KEY("clerk_user_id","id"),
	CONSTRAINT "fitia_gainer_carryover_status" CHECK ("fitia_gainer_carryover"."status" IN ('pending','consumed','cancelled')),
	CONSTRAINT "fitia_gainer_carryover_entry" CHECK (("fitia_gainer_carryover"."status" = 'consumed' AND "fitia_gainer_carryover"."consumed_meal" IS NOT NULL AND "fitia_gainer_carryover"."consumed_item_id" IS NOT NULL) OR ("fitia_gainer_carryover"."status" <> 'consumed' AND "fitia_gainer_carryover"."consumed_meal" IS NULL AND "fitia_gainer_carryover"."consumed_item_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "fitia_gainer_carryover_target_idx" ON "fitia_gainer_carryover" USING btree ("clerk_user_id","target_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fitia_gainer_carryover_entry_idx" ON "fitia_gainer_carryover" USING btree ("clerk_user_id","target_date","consumed_meal","consumed_item_id");
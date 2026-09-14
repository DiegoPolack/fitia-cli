CREATE TABLE "fitia_gainer_config" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Owner-authorized initial inventory. No other user receives an inferred inventory.
INSERT INTO fitia_gainer_config (clerk_user_id, config)
SELECT clerk_user_id, '{"sweetenerInventory":"honey_only"}'::jsonb
FROM fitia_sessions
WHERE clerk_user_id = 'user_3Itb8UB0Xm4qf8UQVt5UdW3TNdw'
ON CONFLICT (clerk_user_id) DO NOTHING;

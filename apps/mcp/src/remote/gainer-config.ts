import { createHash } from "node:crypto";
import { CliError } from "@fitia/core/runtime";
import { SafeWriteCoordinator, type WriteJournal } from "@fitia/core/safe-write";
import {
  type GainerConfigPatch,
  type GainerConfigSnapshot,
  type GainerConfigStore,
  gainerConfigPatch,
  mergeGainerConfig,
  parseGainerConfig,
} from "../gainer-config.ts";
import { type DatabaseRunner, neonDatabase } from "./sessions.ts";

type ConfigDocument = GainerConfigSnapshot & { updateTime: string };

// Identity is injected from verified Clerk AuthInfo; no tool accepts a user ID.
export class GainerConfigRepository implements GainerConfigStore {
  private database: DatabaseRunner;
  constructor(
    private options: { databaseUrl: string; clerkUserId: string; journal: WriteJournal; database?: DatabaseRunner },
  ) {
    this.database = options.database ?? neonDatabase(options.databaseUrl);
  }

  async get(): Promise<ConfigDocument> {
    const result = await this.database.run((client) =>
      client.query<{ config: unknown; version: string }>(
        "SELECT config, version::text AS version FROM fitia_gainer_config WHERE clerk_user_id = $1",
        [this.options.clerkUserId],
      ),
    );
    const row = result.rows[0];
    return {
      config: parseGainerConfig(row?.config ?? {}),
      version: row?.version ?? "0",
      updateTime: row?.version ?? "0",
      persisted: !!row,
    };
  }

  async update(patch: GainerConfigPatch, confirm: boolean, expectedVersion?: string) {
    const validated = gainerConfigPatch.parse(patch);
    if (!Object.keys(validated).length)
      throw new CliError("EMPTY_CONFIG_PATCH", "No configuration changes supplied.", "Specify at least one setting.");
    const before = await this.get();
    const after = parseGainerConfig(mergeGainerConfig(before.config, validated));
    const fieldsChanged = Object.keys(validated).filter(
      (key) =>
        JSON.stringify(before.config[key as keyof typeof after]) !== JSON.stringify(after[key as keyof typeof after]),
    );
    const receipt = {
      operation: "gainer-config-update",
      date: new Date().toISOString().slice(0, 10),
      status: "preview",
      serverVerified: false,
      mobileVerified: false,
      before: before.config,
      after,
      fieldsChanged,
      expectedVersion: before.version,
    };
    if (!confirm) return receipt;
    if (expectedVersion === undefined || expectedVersion !== before.version)
      throw new CliError(
        "CONFIG_VERSION_CONFLICT",
        "Confirmation must reference the current preview version.",
        "Preview the exact patch again and obtain approval for any changed result.",
      );
    if (!fieldsChanged.length) return { ...receipt, status: "already-present", serverVerified: true };
    const coordinator = new SafeWriteCoordinator<ConfigDocument, typeof after>(
      "unused-remote-state",
      async (document, config) => {
        const result = await this.database.run((client) =>
          client.query(
            `INSERT INTO fitia_gainer_config (clerk_user_id, config, version)
           SELECT $1, $2::jsonb, 1 WHERE $3 = '0'
           ON CONFLICT DO NOTHING RETURNING version`,
            [this.options.clerkUserId, JSON.stringify(config), document.version],
          ),
        );
        if (result.rowCount === 1) return;
        if (document.version !== "0") {
          const updated = await this.database.run((client) =>
            client.query(
              `UPDATE fitia_gainer_config SET config = $2::jsonb, version = version + 1, updated_at = now()
             WHERE clerk_user_id = $1 AND version = $3::bigint RETURNING version`,
              [this.options.clerkUserId, JSON.stringify(config), document.version],
            ),
          );
          if (updated.rowCount === 1) return;
        }
        throw new CliError(
          "CONFIG_VERSION_CONFLICT",
          "Configuration changed concurrently; no change was applied by this request.",
          "Read and preview the configuration again.",
        );
      },
      async () => this.get(),
      this.options.journal,
    );
    await coordinator.assertEnabled();
    return coordinator.execute({
      document: before,
      accountId: this.options.clerkUserId,
      receipt,
      hash: createHash("sha256").update(`gainer-config:${this.options.clerkUserId}`).digest("hex"),
      body: after,
      fieldsChanged,
      verify: (document) =>
        document.version === String(BigInt(before.version) + 1n) &&
        JSON.stringify(document.config) === JSON.stringify(after),
    });
  }
}

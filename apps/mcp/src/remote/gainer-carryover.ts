import { createHash } from "node:crypto";
import { validateDate } from "@fitia/core/diary";
import type { CarryoverRecord, MealReference } from "@fitia/core/gainer/carryover";
import { makeCarryoverPlan } from "@fitia/core/gainer/serving";
import { CliError } from "@fitia/core/runtime";
import { SafeWriteCoordinator, type WriteJournal } from "@fitia/core/safe-write";
import { type CarryoverMutation, type CarryoverStore, carryoverDraftSchema } from "../gainer-carryover.ts";
import { parseGainerConfig } from "../gainer-config.ts";
import { type DatabaseRunner, neonDatabase } from "./sessions.ts";

type Document = { record: CarryoverRecord | null; updateTime: string };
type Row = {
  id: string;
  source_date: string;
  target_date: string;
  definition: { draft: unknown; config: unknown };
  status: CarryoverRecord["status"];
  version: string;
  consumed_meal: MealReference["meal"] | null;
  consumed_item_id: string | null;
};
export class GainerCarryoverRepository implements CarryoverStore {
  private database: DatabaseRunner;
  constructor(
    private options: { databaseUrl: string; clerkUserId: string; journal: WriteJournal; database?: DatabaseRunner },
  ) {
    this.database = options.database ?? neonDatabase(options.databaseUrl);
  }
  private decode(row: Row): CarryoverRecord {
    const draft = carryoverDraftSchema.omit({ configVersion: true }).parse(row.definition.draft);
    const plan = makeCarryoverPlan(draft, parseGainerConfig(row.definition.config));
    if (
      plan.id !== row.id ||
      plan.sourceDate !== row.source_date ||
      plan.targetDate !== row.target_date ||
      !["pending", "consumed", "cancelled"].includes(row.status)
    )
      throw new Error("Invalid persisted carryover");
    return {
      ...plan,
      status: row.status,
      version: row.version,
      consumedEntry:
        row.consumed_meal && row.consumed_item_id ? { meal: row.consumed_meal, itemId: row.consumed_item_id } : null,
    };
  }
  private async get(id: string): Promise<Document> {
    const result = await this.database.run((client) =>
      client.query<Row>(
        "SELECT *, version::text AS version FROM fitia_gainer_carryover WHERE clerk_user_id = $1 AND id = $2",
        [this.options.clerkUserId, id],
      ),
    );
    const row = result.rows[0];
    return { record: row ? this.decode(row) : null, updateTime: row?.version ?? "0" };
  }
  async list(targetDate: string) {
    validateDate(targetDate);
    const result = await this.database.run((client) =>
      client.query<Row>(
        "SELECT *, version::text AS version FROM fitia_gainer_carryover WHERE clerk_user_id = $1 AND target_date = $2 ORDER BY created_at, id LIMIT 201",
        [this.options.clerkUserId, targetDate],
      ),
    );
    if (result.rows.length > 200)
      throw new CliError(
        "TOO_MANY_CARRYOVERS",
        "Too many carryovers for this date.",
        "Review the saved batches before automatic calculation.",
      );
    return result.rows.map((row) => this.decode(row));
  }
  async update(
    input: CarryoverMutation,
    verify: (record: CarryoverRecord, reference?: MealReference) => Promise<MealReference | null>,
  ) {
    const id = input.action === "save" ? input.plan.id : input.carryoverId;
    const before = await this.get(id);
    if (input.action !== "save" && !before.record)
      throw new CliError(
        "CARRYOVER_NOT_FOUND",
        "Carryover not found for this user.",
        "Read this user's carryovers first.",
      );
    const current = before.record;
    let after: CarryoverRecord;
    if (input.action === "save") {
      after = current ?? { ...input.plan, status: "pending", version: "1", consumedEntry: null };
    } else {
      if (
        current!.status === "consumed" &&
        input.consumedEntry &&
        JSON.stringify(input.consumedEntry) !== JSON.stringify(current!.consumedEntry)
      )
        throw new CliError(
          "CARRYOVER_STATE_CONFLICT",
          "A consumed carryover cannot be assigned to a different entry.",
          "Use the existing verified receipt.",
        );
      if (current!.status !== "pending" && current!.status !== input.action)
        throw new CliError(
          "CARRYOVER_STATE_CONFLICT",
          "A completed or cancelled carryover cannot change state again.",
          "Read the current carryover status.",
        );
      const entry = await verify(current!, input.consumedEntry ?? current!.consumedEntry ?? undefined);
      if (input.action === "consumed" && !entry)
        throw new CliError(
          "CARRYOVER_NOT_LOGGED",
          "No matching consumed Fitia entry was verified.",
          "Log the morning payload on its actual date, then mark consumed using its receipt.",
        );
      if (input.action === "cancelled" && entry)
        throw new CliError(
          "CARRYOVER_ALREADY_LOGGED",
          "The carryover is already registered in Fitia.",
          "Mark it consumed; cancelling metadata cannot undo a diary entry.",
        );
      after = {
        ...current!,
        status: input.action,
        consumedEntry: entry,
        version: current!.status === input.action ? current!.version : String(BigInt(current!.version) + 1n),
      };
    }
    const unchanged =
      current !== null &&
      current.status === after.status &&
      JSON.stringify(current.consumedEntry) === JSON.stringify(after.consumedEntry);
    const receipt = {
      operation: `gainer-carryover-${input.action}`,
      date: after.targetDate,
      itemId: id,
      status: "preview",
      serverVerified: false,
      mobileVerified: false,
      before: current,
      after,
      expectedVersion: before.updateTime,
    };
    if (!input.confirm) return receipt;
    // A successful retry returns the same immutable batch/state even with the original preview version.
    if (unchanged) return { ...receipt, status: "already-present", serverVerified: true };
    if (input.expectedVersion === undefined || input.expectedVersion !== before.updateTime)
      throw new CliError(
        "CARRYOVER_VERSION_CONFLICT",
        "Confirmation must reference the current preview version.",
        "Preview the exact carryover operation again.",
      );
    const coordinator = new SafeWriteCoordinator<Document, CarryoverRecord>(
      "unused-remote-state",
      async (document, record) => {
        if (input.action !== "save") {
          const latest = await verify(record, record.consumedEntry ?? undefined);
          if (JSON.stringify(latest) !== JSON.stringify(record.consumedEntry))
            throw new CliError(
              "CARRYOVER_DIARY_CHANGED",
              "The Fitia entry changed before the carryover update.",
              "Preview again using the current diary.",
            );
        }
        const result = await this.database
          .run((client) =>
            document.record === null
              ? client.query(
                  "INSERT INTO fitia_gainer_carryover (clerk_user_id, id, source_date, target_date, definition, status) VALUES ($1,$2,$3,$4,$5::jsonb,'pending') ON CONFLICT DO NOTHING RETURNING id",
                  [
                    this.options.clerkUserId,
                    id,
                    record.sourceDate,
                    record.targetDate,
                    JSON.stringify(record.definition),
                  ],
                )
              : client.query(
                  "UPDATE fitia_gainer_carryover SET status=$3, consumed_meal=$4, consumed_item_id=$5, version=version+1, updated_at=now() WHERE clerk_user_id=$1 AND id=$2 AND version=$6::bigint RETURNING id",
                  [
                    this.options.clerkUserId,
                    id,
                    record.status,
                    record.consumedEntry?.meal ?? null,
                    record.consumedEntry?.itemId ?? null,
                    document.updateTime,
                  ],
                ),
          )
          .catch((error: unknown) => {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
              throw new CliError(
                "CARRYOVER_ENTRY_CONFLICT",
                "This Fitia entry is already assigned to another carryover.",
                "Use one exact diary entry per consumed portion.",
              );
            throw error;
          });
        if (result.rowCount !== 1)
          throw new CliError(
            "CARRYOVER_VERSION_CONFLICT",
            "Carryover changed concurrently.",
            "Read and preview again.",
          );
      },
      async () => this.get(id),
      this.options.journal,
    );
    await coordinator.assertEnabled();
    return coordinator.execute({
      document: before,
      accountId: this.options.clerkUserId,
      receipt,
      hash: createHash("sha256").update(`gainer-carryover:${this.options.clerkUserId}:${id}`).digest("hex"),
      body: after,
      fieldsChanged: [input.action === "save" ? "carryover" : "status", "consumedEntry"],
      verify: (document) =>
        document.record?.status === after.status &&
        document.record.version === after.version &&
        JSON.stringify(document.record.consumedEntry) === JSON.stringify(after.consumedEntry),
    });
  }
}

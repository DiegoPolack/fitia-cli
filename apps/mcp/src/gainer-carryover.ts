import type { CarryoverRecord, MealReference } from "@fitia/core/gainer/carryover";
import { gainerRecipe, sweetenerModes } from "@fitia/core/gainer/recipe";
import type { CarryoverPlan } from "@fitia/core/gainer/serving";
import { CliError, mealTypes } from "@fitia/core/runtime";
import * as z from "zod/v4";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const versionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const confirmation = { confirm: z.boolean().default(false), expectedVersion: versionSchema.optional() };
export const carryoverDraftSchema = z.strictObject({
  sourceDate: date,
  recipeId: z.literal(gainerRecipe.id),
  scaleFactor: z.number().positive().max(35),
  sweetener: z.enum(sweetenerModes),
  nightPercent: z.number().int().min(1).max(99),
  configVersion: versionSchema,
  adaptiveAmounts: z
    .record(z.enum(gainerRecipe.ingredients.map((i) => i.id)), z.number().int().min(0).max(1000))
    .optional(),
});
export const carryoverUpdateSchema = z
  .strictObject({
    action: z.enum(["save", "consumed", "cancelled"]),
    draft: carryoverDraftSchema.optional(),
    carryoverId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    consumedEntry: z
      .strictObject({
        meal: z.enum(Object.keys(mealTypes) as [keyof typeof mealTypes, ...(keyof typeof mealTypes)[]]),
        itemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
      })
      .optional(),
    ...confirmation,
  })
  .superRefine((input, ctx) => {
    if (
      input.action === "save"
        ? !input.draft || input.carryoverId || input.consumedEntry
        : !input.carryoverId || input.draft || (input.action === "cancelled" && input.consumedEntry)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "save requires only draft; consumed/cancelled require carryoverId; consumedEntry is only for consumed.",
      });
  });
export type CarryoverMutation =
  | { action: "save"; plan: CarryoverPlan; confirm: boolean; expectedVersion?: string }
  | {
      action: "consumed" | "cancelled";
      carryoverId: string;
      consumedEntry?: MealReference;
      confirm: boolean;
      expectedVersion?: string;
    };
export interface CarryoverStore {
  list(targetDate: string): Promise<CarryoverRecord[]>;
  update(
    input: CarryoverMutation,
    verify: (record: CarryoverRecord, reference?: MealReference) => Promise<MealReference | null>,
  ): Promise<unknown>;
}
export const unconfiguredCarryoverStore: CarryoverStore = {
  async list() {
    return [];
  },
  async update() {
    throw new CliError(
      "REMOTE_CARRYOVER_REQUIRED",
      "Carryover persistence requires the authenticated remote MCP.",
      "Use the existing remote connector.",
    );
  },
};

import { defaultGainerConfig, type GainerConfig, sweetenerModes } from "@fitia/core/gainer/recipe";
import { CliError } from "@fitia/core/runtime";
import * as z from "zod/v4";

const macroProfile = z.strictObject({
  caloriesKcal: z.number().min(0).max(900),
  proteinG: z.number().min(0).max(100),
  carbsG: z.number().min(0).max(100),
  fatG: z.number().min(0).max(100),
});
export const gainerConfigPatch = z.strictObject({
  sweetenerInventory: z.enum(["unknown", ...sweetenerModes]).optional(),
  defaultMode: z.enum(["calories", "fitia_optimal"]).optional(),
  honeyGramsPerTablespoon: z.number().min(1).max(100).optional(),
  preferredNightCaloriesKcal: z.number().min(1).max(20000).optional(),
  maxNightCaloriesKcal: z.number().min(1).max(20000).optional(),
  honeyProfile: z
    .strictObject({
      source: z.enum(["standard_reference", "product_label"]),
      label: z.string().trim().min(1).max(200),
      per100G: macroProfile,
    })
    .optional(),
});
export type GainerConfigPatch = z.infer<typeof gainerConfigPatch>;
export function parseGainerConfig(value: unknown): GainerConfig {
  // Validate stored overrides as strictly as tool input. Never hide corruption behind defaults.
  const config = { ...defaultGainerConfig(), ...gainerConfigPatch.parse(value) };
  if (config.preferredNightCaloriesKcal > config.maxNightCaloriesKcal)
    throw new CliError(
      "INVALID_NIGHT_LIMITS",
      "Preferred night calories cannot exceed the night maximum.",
      "Update both limits together if necessary.",
    );
  return config;
}
export interface GainerConfigSnapshot {
  config: GainerConfig;
  version: string;
  persisted: boolean;
}
export interface GainerConfigStore {
  get(): Promise<GainerConfigSnapshot>;
  update(patch: GainerConfigPatch, confirm: boolean, expectedVersion?: string): Promise<unknown>;
}
export const unconfiguredGainerStore: GainerConfigStore = {
  async get() {
    return { config: defaultGainerConfig(), version: "0", persisted: false };
  },
  async update() {
    throw new CliError(
      "REMOTE_CONFIG_REQUIRED",
      "Persistent gainer configuration requires the authenticated remote MCP.",
      "Connect to the existing Fitia remote MCP; local calculations can use an explicit sweetener.",
    );
  },
};

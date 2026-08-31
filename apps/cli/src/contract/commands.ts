import { type OperationId, operations } from "@fitia/core";
import type { FlagName } from "./flags.ts";
import { outputSchemas } from "./output-schemas.ts";

interface CliCommandConfig {
  readonly options: readonly FlagName[];
  readonly required?: readonly FlagName[];
}

const cli = <Id extends OperationId>(id: Id, config: CliCommandConfig) => ({
  id,
  name: operations[id].cliName,
  description: operations[id].description,
  auth: operations[id].authentication,
  risk: operations[id].risk,
  options: config.options,
  required: config.required ?? [],
  output: outputSchemas[id],
});

export const commands = [
  cli("authLogin", { options: ["wait", "no-open"] }),
  cli("authLogout", { options: [] }),
  cli("authStatus", { options: [] }),
  cli("accountGet", { options: [] }),
  cli("profileGet", { options: [] }),
  cli("premiumGet", { options: [] }),
  cli("foodList", { options: ["country", "query", "limit"] }),
  cli("foodSearch", { options: ["country", "language", "query", "limit"], required: ["query"] }),
  cli("mealGet", { options: ["date"], required: ["date"] }),
  cli("daySummary", { options: ["date"], required: ["date"] }),
  cli("mealSuggest", { options: ["date", "meal", "limit", "foods"], required: ["date", "meal"] }),
  cli("mealLog", {
    options: [
      "date",
      "meal",
      "name",
      "calories",
      "protein",
      "carbs",
      "fat",
      "idempotency-key",
      "occurrence",
      "dry-run",
      "yes",
    ],
    required: ["date", "meal", "name", "calories", "protein", "carbs", "fat"],
  }),
  cli("mealRefresh", { options: ["date", "dry-run", "yes"], required: ["date"] }),
  cli("mealRemove", {
    options: ["date", "meal", "item-id", "dry-run", "yes"],
    required: ["date", "meal", "item-id"],
  }),
  cli("doctor", { options: [] }),
] as const;

export const commandByName = new Map<string, (typeof commands)[number]>(
  commands.map((command) => [command.name, command]),
);

export const aliases: Record<string, string> = Object.values(operations).reduce<Record<string, string>>(
  (all, operation) => {
    for (const alias of "aliases" in operation ? operation.aliases : []) all[alias] = operation.cliName;
    return all;
  },
  {},
);

import { VERSION } from "@fitia/core";
import { aliases, commands } from "./commands.ts";
import { flags } from "./flags.ts";
import { array, booleanSchema, object, stringSchema } from "./json-schema.ts";

export { VERSION } from "@fitia/core";
export { aliases, commandByName, commands } from "./commands.ts";
export { flags } from "./flags.ts";

export const SCHEMA_VERSION = "2";

export const help = {
  name: "fitia",
  version: VERSION,
  description: "Unofficial Fitia CLI. Daily macros, meal suggestions, food search, and quick meal entries.",
  commands: commands.map(({ name, description }) => ({ name, description })),
  utilityCommands: ["schema", "help", "version"],
  aliases,
  flags,
  environment: {
    FITIA_TOKEN: "Raw Firebase ID token. Kept in memory only. An explicit empty value disables saved session lookup.",
    FITIA_DISABLE_WRITES: "Set to 1 to block all meal writes.",
    XDG_STATE_HOME: "Optional private state root; defaults to ~/.local/state. Receipts live in fitia-cli.",
  },
  limitations: [
    "Meal writes are quick entries with explicit totals, not full database-linked food or recipe objects.",
    "Logs clear the diary's origin marker to request a Mobile Refresh. Server verification does not prove the phone rendered it.",
    "No missing-day creation, billing changes, or account deletion.",
    "Saved login requires macOS Keychain. Other platforms use environment or stdin tokens.",
    "food search queries the nutrition database; food list only lists onboarding preferences.",
  ],
};

const stringsSchema = array(stringSchema);
const metaSchema = object({
  schemaVersion: { const: SCHEMA_VERSION },
  command: stringSchema,
  nextSteps: stringsSchema,
  untrustedData: booleanSchema,
});

export function schema() {
  return {
    version: SCHEMA_VERSION,
    cliVersion: VERSION,
    success: object({ ok: { const: true }, data: {}, meta: metaSchema }),
    error: object({
      ok: { const: false },
      error: object({ code: stringSchema, message: stringSchema, hint: stringSchema }),
      meta: metaSchema,
    }),
    errorStream: "stderr",
    successStream: "stdout",
    exitCodes: {
      "0": "Success",
      "2": "Invalid arguments or input",
      "3": "Authentication failure or unhealthy doctor result",
      "4": "Network or provider failure",
      "5": "Local system failure",
    },
    commands: commands.map(({ name, description, auth, risk, options, required, output }) => ({
      name,
      description,
      risk,
      authentication: auth,
      input: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          ["json", "help", "timeout", ...(auth ? ["token-stdin"] : []), ...options].map((key) => [
            key,
            { type: flags[key as keyof typeof flags].type },
          ]),
        ),
        required,
      },
      data: output,
    })),
    utilityCommands: {
      schema: {
        description: "This runtime contract",
        data: {
          type: "object",
          required: ["version", "cliVersion", "success", "error", "commands", "utilityCommands"],
        },
      },
      help: { description: "Help and available commands", data: { type: "object", required: Object.keys(help) } },
      version: { data: object({ version: stringSchema }) },
    },
    aliases,
  };
}

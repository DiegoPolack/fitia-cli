export const flags = {
  json: { type: "boolean", description: "Print JSON. Automatic when stdout is not a terminal." },
  help: { type: "boolean", short: "h", description: "Show help without network access." },
  version: { type: "boolean", description: "Show the version." },
  "token-stdin": { type: "boolean", description: "Read a raw ID token from piped stdin. Never saved." },
  timeout: { type: "string", description: "Timeout per request in seconds, 1 to 120. Default 15." },
  country: { type: "string", description: "Two letter country code for foods. Default pe." },
  query: { type: "string", description: "Food search text. Required for food search; a local filter for food list." },
  language: { type: "string", description: "Food search language: es or en. Default es." },
  limit: {
    type: "string",
    description: "Food search: 1 to 50, default 10. Meal suggestions: 1 to 10, default 5. Food list: 1 to 500.",
  },
  foods: {
    type: "string",
    description: "Comma-separated planner food IDs to narrow saved choices for meal suggest, e.g. 1,4.",
  },
  wait: { type: "string", description: "Login deadline in seconds, 1 to 600. Required for noninteractive login." },
  "no-open": { type: "boolean", description: "Print the login URL without opening the default browser." },
  date: { type: "string", description: "Explicit local calendar date, YYYY-MM-DD." },
  meal: { type: "string", description: "breakfast, snack-1, lunch, snack-2, or dinner." },
  "item-id": {
    type: "string",
    description: "Exact quick entry ID from meal get or a log receipt. Required for removal.",
  },
  name: { type: "string", description: "Quick entry name including the serving description." },
  calories: { type: "string", description: "Total kcal for the entry." },
  protein: { type: "string", description: "Total grams of protein for the entry." },
  carbs: { type: "string", description: "Total grams of carbs for the entry." },
  fat: { type: "string", description: "Total grams of fat for the entry." },
  "idempotency-key": {
    type: "string",
    description: "Stable key identifying one intended entry. Reuse after uncertainty.",
  },
  occurrence: {
    type: "string",
    description: "Identical-entry occurrence from 1 to 999. Default 1; used only when deriving an idempotency key.",
  },
  "dry-run": { type: "boolean", description: "Read and validate the real diary, then preview without writing." },
  yes: { type: "boolean", description: "Submit the specified meal log, removal, or mobile refresh." },
} as const;

export type FlagName = keyof typeof flags;

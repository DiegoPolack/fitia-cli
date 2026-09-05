export const VERSION = "0.7.0";

export type OperationRisk = "read-only" | "write" | "local-credentials";

interface OperationDefinition {
  readonly cliName: string;
  readonly description: string;
  readonly authentication: boolean;
  readonly risk: OperationRisk;
  readonly aliases?: readonly string[];
  readonly mcpName?: `fitia-${string}`;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
}

export const operations = {
  authLogin: {
    cliName: "auth login",
    description: "Sign in with Google and save a renewable session in the OS-protected credential store.",
    authentication: false,
    risk: "local-credentials",
  },
  authLogout: {
    cliName: "auth logout",
    description: "Remove only the Fitia CLI session from the OS-protected credential store.",
    authentication: false,
    risk: "local-credentials",
  },
  authStatus: {
    cliName: "auth status",
    description: "Inspect whether Fitia credentials are configured. This does not verify identity.",
    authentication: true,
    risk: "read-only",
    mcpName: "fitia-auth-status",
  },
  accountGet: {
    cliName: "account get",
    description: "Verify credentials and read the current Fitia account identity.",
    authentication: true,
    risk: "read-only",
    aliases: ["whoami"],
    mcpName: "fitia-account-get",
  },
  profileGet: {
    cliName: "profile get",
    description: "Read the current account's Fitia profile.",
    authentication: true,
    risk: "read-only",
    mcpName: "fitia-profile-get",
  },
  premiumGet: {
    cliName: "premium get",
    description: "Check whether the current Fitia account has Premium.",
    authentication: true,
    risk: "read-only",
    aliases: ["premium"],
    mcpName: "fitia-premium-get",
  },
  foodList: {
    cliName: "food list",
    description: "List public onboarding food preferences. This is not the nutrition database.",
    authentication: false,
    risk: "read-only",
    mcpName: "fitia-food-list",
  },
  foodSearch: {
    cliName: "food search",
    description: "Search Fitia foods and recipes with nutrition and serving information.",
    authentication: true,
    risk: "read-only",
    aliases: ["search"],
    mcpName: "fitia-food-search",
  },
  mealGet: {
    cliName: "meal get",
    description: "Read the synced meals for one Fitia diary date.",
    authentication: true,
    risk: "read-only",
    mcpName: "fitia-meal-get",
  },
  daySummary: {
    cliName: "day summary",
    description: "Read goals, consumed macros, remaining amounts, and coverage for one date.",
    authentication: true,
    risk: "read-only",
    mcpName: "fitia-day-summary",
  },
  mealSuggest: {
    cliName: "meal suggest",
    description:
      "Get read-only Fitia meal suggestions ranked against the day's remaining targets. This never logs food.",
    authentication: true,
    risk: "read-only",
    mcpName: "fitia-meal-suggest",
  },
  mealLog: {
    cliName: "meal log",
    description: "Preview or commit one explicit quick meal entry.",
    authentication: true,
    risk: "write",
    mcpName: "fitia-meal-log",
    destructive: false,
    idempotent: true,
  },
  mealRefresh: {
    cliName: "meal refresh",
    description: "Preview or clear a diary's device marker so the mobile app can import server changes.",
    authentication: true,
    risk: "write",
    mcpName: "fitia-meal-refresh",
    destructive: false,
    idempotent: true,
  },
  mealRemove: {
    cliName: "meal remove",
    description: "Preview or remove exactly one quick entry by ID.",
    authentication: true,
    risk: "write",
    mcpName: "fitia-meal-remove",
    destructive: true,
    idempotent: true,
  },
  doctor: {
    cliName: "doctor",
    description: "Verify credentials with a live Premium read.",
    authentication: true,
    risk: "read-only",
  },
} as const satisfies Record<string, OperationDefinition>;

export type OperationId = keyof typeof operations;

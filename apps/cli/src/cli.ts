import { parseArgs } from "node:util";
import type { LogInput, MealName, RemoveInput, SuggestInput } from "@fitia/core";
import {
  CliError,
  cleanToken,
  DiaryClient,
  FitiaClient,
  keychain,
  openLogin,
  readTokenStdin,
  requireToken,
  safeText,
  sessionCredentials,
  startLogin,
  tokenStatus,
  validateDate,
  validateLog,
  validateRemove,
  validateSuggestion,
  validateWrite,
} from "@fitia/core";
import { aliases, commandByName, commands, flags, help, SCHEMA_VERSION, schema, VERSION } from "./contract/index.ts";

function suggestInput(values: Record<string, string | boolean | undefined>): SuggestInput {
  const raw = values.foods;
  if (raw !== undefined && (typeof raw !== "string" || !/^\d{1,6}(,\d{1,6}){0,99}$/.test(raw)))
    throw new CliError(
      "INVALID_FOODS",
      "Expected comma-separated planner food IDs.",
      "For example, --foods 1,4. This narrows your saved food choices.",
    );
  return {
    date: String(values.date ?? ""),
    meal: String(values.meal ?? "") as MealName,
    limit: positiveInteger(values.limit as string | undefined, "limit", 10, 5)!,
    foods: typeof raw === "string" ? raw.split(",").map(Number) : undefined,
  };
}

function removeInput(values: Record<string, string | boolean | undefined>): RemoveInput {
  return {
    date: String(values.date ?? ""),
    meal: String(values.meal ?? "") as MealName,
    itemId: String(values["item-id"] ?? ""),
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
  };
}

function logInput(values: Record<string, string | boolean | undefined>): LogInput {
  const amount = (key: string) =>
    typeof values[key] === "string" && /^(?:\d+)(?:\.\d+)?$/.test(values[key] as string) ? Number(values[key]) : NaN;
  return {
    date: String(values.date ?? ""),
    meal: String(values.meal ?? "") as MealName,
    name: String(values.name ?? ""),
    caloriesKcal: amount("calories"),
    proteinG: amount("protein"),
    carbsG: amount("carbs"),
    fatG: amount("fat"),
    idempotencyKey: typeof values["idempotency-key"] === "string" ? values["idempotency-key"] : undefined,
    occurrence: positiveInteger(
      typeof values.occurrence === "string" ? values.occurrence : undefined,
      "occurrence",
      999,
    ),
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
  };
}

function positiveInteger(value: string | undefined, name: string, max: number, fallback?: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
    throw new CliError("INVALID_ARGUMENT", `Invalid ${name}.`, `Use an integer from 1 to ${max}.`);
  return Number(value);
}

const parseCliArgs = (argv: string[]) =>
  parseArgs({ args: argv, options: flags, allowPositionals: true, strict: true, tokens: true });

function parse(argv: string[]) {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Unknown option or missing option value.",
      "Run fitia --help. Pass tokens through the environment or stdin, never as arguments.",
    );
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name))
      throw new CliError("DUPLICATE_OPTION", "An option was supplied more than once.", "Supply each option once.");
    seen.add(token.name);
  }
  const raw = parsed.positionals.join(" ");
  const command = aliases[raw] ?? (raw || "help");
  const definition = commandByName.get(command);
  if (!definition && !["help", "schema", "version"].includes(command))
    throw new CliError("UNKNOWN_COMMAND", "Unknown command.", "Run fitia --help for the verified command surface.");
  const allowed = new Set([
    "json",
    "help",
    "version",
    "timeout",
    ...(definition?.auth ? ["token-stdin"] : []),
    ...(definition?.options ?? []),
  ]);
  for (const name of seen)
    if (!allowed.has(name))
      throw new CliError(
        "UNEXPECTED_OPTION",
        "This command does not accept one of the supplied options.",
        "Use fitia schema to inspect command inputs.",
      );
  const values = parsed.values;
  const timeoutMs = positiveInteger(values.timeout, "timeout", 120, 15)! * 1000;
  if (values.help) return { command: "help", values, timeoutMs };
  if (values.version) return { command: "version", values, timeoutMs };
  if (values.country !== undefined && !/^[a-zA-Z]{2}$/.test(values.country))
    throw new CliError("INVALID_COUNTRY", "Expected a two letter country code.", "For example, --country pe.");
  if (values.query !== undefined && (values.query.trim().length === 0 || values.query.length > 200))
    throw new CliError("INVALID_QUERY", "Use a food name from 1 to 200 characters.", "For example, --query pollo.");
  if (command === "food search" && !values.query)
    throw new CliError("QUERY_REQUIRED", "A food search query is required.", "Run fitia food search --query pollo.");
  if (values.language !== undefined && !/^(es|en)$/i.test(values.language))
    throw new CliError("INVALID_LANGUAGE", "Unsupported food search language.", "Use --language es or --language en.");
  positiveInteger(values.limit, "limit", command === "food search" ? 50 : 500);
  positiveInteger(values.wait, "wait", 600);
  if (command === "auth login" && !values.wait && !process.stdin.isTTY)
    throw new CliError(
      "LOGIN_WAIT_REQUIRED",
      "Noninteractive login needs an explicit deadline.",
      "Run fitia auth login --wait 300. Complete Google sign in in the browser.",
    );
  if (["meal get", "day summary", "meal suggest"].includes(command)) validateDate(values.date ?? "");
  if (command === "meal suggest") validateSuggestion(suggestInput(values));
  if (command === "meal log") validateLog(logInput(values));
  if (command === "meal refresh")
    validateWrite({ date: values.date ?? "", dryRun: values["dry-run"] === true, yes: values.yes === true });
  if (command === "meal remove") validateRemove(removeInput(values));
  return { command, values, timeoutMs };
}

const displayNumber = (n: number | null) => (n === null ? "unknown" : String(Math.round(n * 100) / 100));
function dayLines(data: any): string[] {
  return [
    `Nutrition for ${data.date}`,
    "                     Goal    Consumed        Left",
    ...[
      ["caloriesKcal", "Calories (kcal)"],
      ["proteinG", "Protein (g)"],
      ["carbsG", "Carbs (g)"],
      ["fatG", "Fat (g)"],
    ].map(
      ([key, label]) =>
        `${label!.padEnd(17)}${displayNumber(data.goals[key!]).padStart(8)}${displayNumber(data.consumed[key!]).padStart(12)}${displayNumber(data.remaining[key!]).padStart(12)}`,
    ),
    "Negative remaining values mean the goal is exceeded.",
    ...data.warnings.map((w: string) => `Note: ${safeText(w)}`),
  ];
}
function human(command: string, data: any): string {
  if (command === "help")
    return [
      `fitia ${VERSION}`,
      help.description,
      "",
      "Usage: fitia <noun> <verb> [options]",
      "",
      ...commands.map((c) => `  ${c.name.padEnd(18)} ${c.description}`),
      "  schema             Inspect the versioned JSON contract.",
      "  help               Show this help.",
      "  version            Show the version.",
      "",
      "Shortcuts: fitia search --query pollo, fitia premium, fitia whoami",
      "",
      ...Object.entries(flags).map(([key, value]) => `  --${key.padEnd(17)} ${value.description}`),
      "",
      "Auth: fitia auth login --wait 300 (macOS Keychain), FITIA_TOKEN, or --token-stdin.",
      "",
      ...help.limitations,
    ].join("\n");
  if (command === "version") return data.version;
  if (command === "auth login")
    return `Connected as ${safeText(data.email ?? data.accountId)}. Session saved in macOS Keychain.`;
  if (command === "auth logout") return "Fitia CLI saved session removed. Environment tokens are unchanged.";
  if (command === "day summary") return dayLines(data).join("\n");
  if (command === "meal suggest")
    return [
      ...dayLines(data.day),
      "",
      `Fitia suggestions for ${safeText(data.meal)}: ${data.status}`,
      ...(data.budget
        ? [
            `Meal budget: ${data.budget.caloriesKcal} kcal; protein ${data.budget.proteinG} g; carbs ${data.budget.carbsG} g; fat ${data.budget.fatG} g`,
          ]
        : []),
      ...data.suggestions.flatMap((s: any) => [
        "",
        `${s.rank}. ${s.foods.map((f: any) => `${safeText(f.name)}, ${displayNumber(f.portion.size)} ${safeText(f.portion.unit)} (${safeText(f.portion.cookingState)})`).join(" + ")}`,
        `   ${displayNumber(s.totals.caloriesKcal)} kcal; protein ${displayNumber(s.totals.proteinG)} g; carbs ${displayNumber(s.totals.carbsG)} g; fat ${displayNumber(s.totals.fatG)} g`,
        `   Left afterward: ${displayNumber(s.remainingAfter.caloriesKcal)} kcal; protein ${displayNumber(s.remainingAfter.proteinG)} g; carbs ${displayNumber(s.remainingAfter.carbsG)} g; fat ${displayNumber(s.remainingAfter.fatG)} g`,
        ...s.tradeoffs.map((t: string) => `   ${safeText(t)}`),
        ...s.foods.flatMap((f: any) => f.preparationNotes.map((note: string) => `   ${safeText(note)}`)),
      ]),
      "",
      ...data.warnings.map((w: string) => `Note: ${safeText(w)}`),
    ].join("\n");
  if (command === "meal get")
    return [
      `Meals for ${data.date}`,
      ...data.meals.flatMap((m: any) => [
        "",
        safeText(m.name),
        ...m.items.map(
          (i: any) =>
            `  ${i.eaten ? "Logged" : "Planned"}: ${safeText(i.name)}${i.caloriesKcal === null ? "" : ` (${i.caloriesKcal} kcal)`}\n    ID: ${safeText(i.id)}`,
        ),
      ]),
      "",
      "Database entry totals and mobile display are not inferred.",
    ].join("\n");
  if (command === "meal log")
    return `${data.status === "preview" ? "Preview only; nothing written" : data.status === "already-present" ? "Already present; no duplicate added" : "Quick entry committed and verified on the server"}\n${data.date} / ${data.meal}: ${safeText(data.entry.name)}\n${data.entry.caloriesKcal} kcal; protein ${data.entry.proteinG} g; carbs ${data.entry.carbsG} g; fat ${data.entry.fatG} g\nItem: ${data.itemId}\nIdempotency key: ${data.idempotencyKey}\nMobile display not verified by the CLI.`;
  if (command === "meal refresh")
    return `${data.status === "preview" ? "Preview only; would clear the diary's device marker" : data.status === "already-requested" ? "The diary's device marker is already clear; no write needed" : "Device marker cleared and verified on the server"}\nDate: ${data.date}\nMeals and totals unchanged. Open Fitia online to receive the update.\nMobile display not verified by the CLI.`;
  if (command === "meal remove") {
    const kcal = (n: number) => String(Math.round(n * 100) / 100);
    return `${data.status === "preview" ? "Preview only; nothing removed" : data.status === "already-absent" ? "Entry already absent; nothing changed" : "Entry removed and verified on the server"}\n${data.date} / ${data.meal}${data.entry ? `: ${safeText(data.entry.name)}` : ""}\nItem: ${safeText(data.itemId)}\nCalories ${data.status === "preview" ? "to remove" : "removed"}: ${kcal(data.caloriesRemovedKcal)} kcal\nDay total: ${kcal(data.consumedCaloriesBeforeKcal)} to ${kcal(data.consumedCaloriesAfterKcal)} kcal\n${data.status === "already-absent" ? "No sync update needed." : data.status === "preview" ? "The same write will request mobile refresh." : "Mobile refresh requested."} Mobile display not verified by the CLI.`;
  }
  if (command === "premium get") return `Premium: ${data.isPremium ? "active" : "not active"}`;
  if (command === "auth status")
    return data.configured
      ? `Token: supplied via ${data.source}\nExpires: ${data.expiresAt ?? "unknown"}\nExpired: ${data.expired ?? "unknown"}\nIdentity not verified. Run fitia whoami.`
      : "No token configured. Set FITIA_TOKEN or use --token-stdin.";
  if (command === "account get")
    return `${safeText(data.name ?? "Fitia account")}\nEmail: ${safeText(data.email ?? "not provided")}\nAccount: ${safeText(data.id)}\nEmail verified: ${data.emailVerified}`;
  if (command === "profile get")
    return `${safeText(data.name ?? "Fitia profile")}\nCountry: ${safeText(data.country ?? "unknown")}\nGoal: ${safeText(data.goal ?? "unknown")}\nPremium: ${data.isPremium ? "active" : "not active"}`;
  if (command === "food list")
    return [
      `Food preferences for ${data.country.toUpperCase()} (${data.count} of ${data.total})`,
      "Onboarding choices only. No calories, macros, or diary entries.",
      "",
      ...data.foods.map(
        (f: any) =>
          `${String(f.id).padStart(3)}  ${safeText(f.names.es)} / ${safeText(f.names.en)}  (${safeText(f.category)})`,
      ),
    ].join("\n");
  if (command === "food search") {
    const number = (value: number | null) => (value === null ? "unknown" : String(Math.round(value * 100) / 100));
    return [
      `Food search: ${safeText(data.query)} (${data.country.toUpperCase()}, ${data.language.toUpperCase()})`,
      `${data.count} result${data.count === 1 ? "" : "s"} shown (limit ${data.limit}). More matches may exist.`,
      "",
      ...data.foods.flatMap((f: any, i: number) => {
        const macro = f.nutrition.perServing ?? f.nutrition.per100;
        const unit = f.nutrition.basis === "per-gram" ? "g" : "ml";
        const basisLabel = f.nutrition.perServing ? "Per serving" : `Per 100 ${unit}`;
        return [
          `${i + 1}. ${safeText(f.name)}${f.brand ? ` (${safeText(f.brand)})` : ""}${f.reference.collection === "recipe" ? " [Recipe]" : ""}`,
          macro
            ? `   ${basisLabel}${f.cookingState ? `, ${safeText(f.cookingState)}` : ""}: ${number(macro.caloriesKcal)} kcal; protein ${number(macro.proteinG)} g; carbs ${number(macro.carbsG)} g; fat ${number(macro.fatG)} g`
            : "   Nutrient basis unverified. Use JSON for provider values.",
          `   ID: ${safeText(f.id)}`,
          "",
        ];
      }),
      "No serving or cooking conversion. Use --json for nutrient values and serving sizes.",
    ].join("\n");
  }
  if (command === "doctor")
    return [
      data.healthy ? "Fitia connection is ready." : "Fitia needs attention.",
      ...data.checks.map((c: any) => `${c.status.toUpperCase()}  ${c.name}: ${safeText(c.message)}`),
    ].join("\n");
  return JSON.stringify(data, null, 2);
}

function nextSteps(command: string): string[] {
  if (["help", "schema", "version"].includes(command))
    return ["fitia auth status", "fitia food search --query pollo --limit 5"];
  if (command === "auth status") return ["fitia whoami", "fitia doctor"];
  if (command === "account get") return ["fitia profile get", "fitia premium"];
  return [];
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  let command = "unknown";
  let json = argv.includes("--json") || !process.stdout.isTTY;
  try {
    const parsed = parse(argv);
    command = parsed.command;
    const { values, timeoutMs } = parsed;
    json = values.json || !process.stdout.isTTY;
    const needsToken = commandByName.get(command)?.auth;
    const source = values["token-stdin"] ? "stdin" : process.env.FITIA_TOKEN !== undefined ? "environment" : "keychain";
    let trustedAccountId: string | undefined;
    let token: string | undefined;
    if (needsToken) {
      if (source === "stdin") token = await readTokenStdin(timeoutMs);
      else if (source === "environment") token = cleanToken(process.env.FITIA_TOKEN);
      else {
        const saved = await sessionCredentials(keychain, command !== "auth status");
        token = saved?.token;
        trustedAccountId = saved?.uid;
      }
    }
    const client = new FitiaClient(token, timeoutMs);
    let data: unknown;
    let exitCode = 0;
    switch (command) {
      case "help":
        data = help;
        break;
      case "version":
        data = { version: VERSION };
        break;
      case "schema":
        data = schema();
        break;
      case "auth status":
        data = tokenStatus(token, source);
        break;
      case "auth login": {
        if (process.platform !== "darwin")
          throw new CliError(
            "KEYCHAIN_UNAVAILABLE",
            "Saved login currently requires macOS.",
            "Use FITIA_TOKEN or --token-stdin on this platform.",
            5,
          );
        const login = await startLogin({
          waitSeconds: positiveInteger(values.wait, "wait", 600, 300)!,
          onReady(url) {
            process.stderr.write(`Open this local page to sign in to your existing Fitia account:\n${url}\n`);
            if (!values["no-open"]) openLogin(url);
          },
        });
        data = await login.result;
        break;
      }
      case "auth logout":
        await keychain.remove();
        data = { removed: true };
        break;
      case "meal get":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).get(values.date!);
        break;
      case "day summary":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).summary(values.date!);
        break;
      case "meal suggest":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).suggest(
          suggestInput(values),
        );
        break;
      case "meal log":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).log(logInput(values));
        break;
      case "meal refresh":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).refresh({
          date: values.date!,
          dryRun: values["dry-run"] === true,
          yes: values.yes === true,
        });
        break;
      case "meal remove":
        data = await new DiaryClient(token, timeoutMs, fetch, undefined, trustedAccountId).remove(removeInput(values));
        break;
      case "account get":
        data = await client.account();
        break;
      case "profile get":
        data = await client.profile();
        break;
      case "premium get":
        data = await client.premium();
        break;
      case "food list":
        data = await client.foods(
          (values.country ?? "pe").toLowerCase(),
          values.query,
          positiveInteger(values.limit, "limit", 500),
        );
        break;
      case "food search":
        data = await client.searchFoods(
          values.query!,
          values.country ?? "pe",
          values.language ?? "es",
          positiveInteger(values.limit, "limit", 50, 10),
        );
        break;
      case "doctor": {
        const checks = [
          {
            name: "credentials",
            status: token ? "pass" : "fail",
            message: token ? "ID token supplied." : "No ID token supplied.",
          },
        ];
        try {
          requireToken(token);
          await client.premium();
          checks.push({ name: "fitia", status: "pass", message: "Authenticated Premium request succeeded." });
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          checks.push({ name: "fitia", status: "fail", message: `${error.message} ${error.hint}` });
          exitCode = error.exitCode;
        }
        data = { healthy: checks.every((c) => c.status === "pass"), checks };
        break;
      }
      default:
        throw new CliError("UNKNOWN_COMMAND", "Unknown command.", "Run fitia --help.");
    }
    const meta = { schemaVersion: SCHEMA_VERSION, command, nextSteps: nextSteps(command), untrustedData: true };
    process.stdout.write(`${json ? JSON.stringify({ ok: true, data, meta }) : human(command, data)}\n`);
    return exitCode;
  } catch (error) {
    const known =
      error instanceof CliError
        ? error
        : new CliError(
            "SYSTEM_ERROR",
            "The command could not complete.",
            "Check local file permissions and dependencies, then retry.",
            5,
          );
    const payload = {
      ok: false,
      error: { code: known.code, message: known.message, hint: known.hint },
      meta: { schemaVersion: SCHEMA_VERSION, command, nextSteps: [], untrustedData: true },
    };
    process.stderr.write(`${json ? JSON.stringify(payload) : `${known.code}: ${known.message}\n${known.hint}`}\n`);
    return known.exitCode;
  }
}

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { operations, safeText } from "@fitia/core";
import Ajv from "ajv";
import { commands, schema, VERSION } from "../apps/cli/src/contract/index.ts";

const contract = schema();
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
const envelope = ajv.compile(contract.success);
const errorEnvelope = ajv.compile(contract.error);
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;

async function cli(
  args: string[],
  options: { auth?: boolean; mock?: boolean; input?: string; stateRoot?: string } = {},
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult) => {
    const env = { ...process.env };
    env.FITIA_TOKEN = ""; // Never inspect the developer's saved Keychain session in tests.
    delete env.NODE_OPTIONS;
    if (options.stateRoot) {
      env.XDG_STATE_HOME = options.stateRoot;
      delete env.FITIA_DISABLE_WRITES;
    }
    if (options.auth) env.FITIA_TOKEN = token;
    const bunArgs = options.mock ? ["--preload", resolve("test/fixtures/api-preload.mjs")] : [];
    const child = execFile(
      "bun",
      [...bunArgs, resolve("apps/cli/dist/fitia.js"), ...args],
      { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolveResult({ code: error ? Number(error.code) || 1 : 0, stdout, stderr });
      },
    );
    child.stdin!.end(options.input ?? "");
  });
}

function checkData(command: string, data: unknown) {
  const definition = contract.commands.find((c) => c.name === command)!;
  const valid = ajv.compile(definition.data);
  expect(valid(data), JSON.stringify(valid.errors)).toBe(true);
}

describe("the built executable", () => {
  test.each([[], ["--help"], ["help"], ["-h"]].map((args) => ({ args })))(
    "help and bare invoke keep stdout parseable",
    async ({ args }) => {
      const result = await cli(args);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(envelope(parsed)).toBe(true);
      expect(parsed.meta.command).toBe("help");
      expect(parsed.data.name).toBe("fitia");
    },
  );
  test("schema is versioned and declares every command", async () => {
    const result = await cli(["schema"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual(contract);
    expect(contract.version).toBe("2");
    expect(contract.cliVersion).toBe("0.7.0");
    for (const command of contract.commands)
      if (command.name !== "doctor") expect(command.name).toMatch(/^[a-z]+ [a-z]+$/);
    expect(commands).toHaveLength(Object.keys(operations).length);
    for (const command of commands) {
      expect(command.name).toBe(operations[command.id].cliName);
      expect(command.description).toBe(operations[command.id].description);
      expect(command.auth).toBe(operations[command.id].authentication);
      expect(command.risk).toBe(operations[command.id].risk);
    }
  });
  test.each([["version"], ["--version"]].map((args) => ({ args })))("version contract", async ({ args }) => {
    const result = await cli(args);
    expect(JSON.parse(result.stdout).data).toEqual({ version: VERSION });
    expect(VERSION).toBe("0.7.0");
  });
  test.each(["auth status", "account get", "profile get", "premium get", "food list", "doctor"])(
    "%s returns its data contract",
    async (command) => {
      const result = await cli(command.split(" "), { auth: true, mock: true });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(envelope(parsed)).toBe(true);
      checkData(command, parsed.data);
      expect(parsed.meta.command).toBe(command);
      expect(result.stdout).not.toContain(token);
      expect(result.stdout).not.toContain("private omitted");
      expect(result.stdout).not.toContain("secret omitted");
    },
  );
  test("JSON flag before command is not consumed as input", async () => {
    const result = await cli(["--json", "premium"], { auth: true, mock: true });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).meta.command).toBe("premium get");
  });
  test("whoami resolves to account get", async () => {
    const result = await cli(["whoami"], { auth: true, mock: true });
    expect(JSON.parse(result.stdout).meta.command).toBe("account get");
  });
  test.each(["food search", "search"])("%s returns nutrition through the built executable", async (command) => {
    const result = await cli([...command.split(" "), "--query", "sample", "--limit", "5", "--language", "EN"], {
      auth: true,
      mock: true,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.meta.command).toBe("food search");
    checkData("food search", output.data);
    expect(output.data.language).toBe("en");
    expect(output.data.foods[0].nutrition.per100.caloriesKcal).toBe(120);
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).not.toContain("secret-omitted");
    expect(result.stdout).not.toContain("private omitted");
  });
  test("piped tokens remain private", async () => {
    const result = await cli(["premium", "--token-stdin"], { input: `${token}\n`, mock: true });
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  test("installed diary read and preview conform to the runtime contract", async () => {
    const get = await cli(["meal", "get", "--date", "2026-08-30"], { auth: true, mock: true });
    expect(get.code).toBe(0);
    checkData("meal get", JSON.parse(get.stdout).data);
    const preview = await cli(
      [
        "meal",
        "log",
        "--date",
        "2026-08-30",
        "--meal",
        "breakfast",
        "--name",
        "Synthetic serving",
        "--calories",
        "100",
        "--protein",
        "3",
        "--carbs",
        "12",
        "--fat",
        "4",
        "--idempotency-key",
        "sample",
        "--dry-run",
      ],
      { auth: true, mock: true },
    );
    expect(preview.code).toBe(0);
    checkData("meal log", JSON.parse(preview.stdout).data);
    expect(JSON.parse(preview.stdout).data.status).toBe("preview");
    expect(preview.stderr).toBe("");
    const automatic = await cli(
      [
        "meal",
        "log",
        "--date",
        "2026-08-30",
        "--meal",
        "breakfast",
        "--name",
        "Synthetic serving",
        "--calories",
        "100",
        "--protein",
        "3",
        "--carbs",
        "12",
        "--fat",
        "4",
        "--occurrence",
        "2",
        "--dry-run",
      ],
      { auth: true, mock: true },
    );
    expect(automatic.code).toBe(0);
    expect(JSON.parse(automatic.stdout).data.idempotencyKey).toMatch(/^auto:/);
  });
  test("built daily summary and native suggestions expose versioned read-only results", async () => {
    const summary = await cli(["day", "summary", "--date", "2026-08-30"], { auth: true, mock: true });
    expect(summary.code).toBe(0);
    expect(summary.stderr).toBe("");
    const day = JSON.parse(summary.stdout).data;
    checkData("day summary", day);
    expect(day.consumed).toEqual({ caloriesKcal: 80, proteinG: 1, carbsG: 9, fatG: 4 });
    const suggest = await cli(
      ["meal", "suggest", "--date", "2026-08-30", "--meal", "dinner", "--foods", "1", "--limit", "1"],
      { auth: true, mock: true },
    );
    expect(suggest.code).toBe(0);
    expect(suggest.stderr).toBe("");
    const result = JSON.parse(suggest.stdout).data;
    checkData("meal suggest", result);
    expect(result.status).toBe("ok");
    expect(result.readOnly).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].totals.caloriesKcal).toBe(480);
    expect(result.suggestions[0].foods[0].entry.name).toContain("400 g (Raw)");
    expect(summary.stdout + suggest.stdout).not.toContain(token);
    expect(summary.stdout + suggest.stdout).not.toContain("synthetic-device-marker");
    for (const command of ["day summary", "meal suggest"])
      expect(contract.commands.find((c) => c.name === command)!.risk).toBe("read-only");
  });
  test.each(
    [
      ["day", "summary"],
      ["day", "summary", "--date", "2026-02-30"],
      ["day", "summary", "--date", "2026-08-30", "--yes"],
      ["meal", "suggest", "--date", "2026-08-30"],
      ["meal", "suggest", "--date", "2026-08-30", "--meal", "snack"],
      ["meal", "suggest", "--date", "2026-08-30", "--meal", "dinner", "--foods", "1,,4"],
      ["meal", "suggest", "--date", "2026-08-30", "--meal", "dinner", "--foods", "1,1"],
      ["meal", "suggest", "--date", "2026-08-30", "--meal", "dinner", "--limit", "11"],
    ].map((args) => ({ args })),
  )("new commands validate locally before credential lookup", async ({ args }) => {
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(errorEnvelope(JSON.parse(result.stderr))).toBe(true);
  });
  test("built refresh previews and commits the single-field contract with no credential exposure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "fitia-refresh-cli-test-"));
    try {
      for (const flag of ["--dry-run", "--yes"]) {
        const result = await cli(["meal", "refresh", "--date", "2026-08-30", flag], {
          auth: true,
          mock: true,
          stateRoot,
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const output = JSON.parse(result.stdout);
        checkData("meal refresh", output.data);
        expect(output.data.status).toBe(flag === "--yes" ? "committed" : "preview");
        expect(output.data.fieldsChanged).toEqual(["fcmToken"]);
        expect(output.meta.nextSteps).toEqual([]);
        expect(result.stdout).not.toContain(token);
        expect(result.stdout).not.toContain("synthetic-device-marker");
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }, 40_000);
  test("built removal previews and commits the scoped deletion contract without exposing credentials", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "fitia-remove-cli-test-"));
    try {
      for (const flag of ["--dry-run", "--yes"]) {
        const result = await cli(
          ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--item-id", "existing", flag],
          { auth: true, mock: true, stateRoot },
        );
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const output = JSON.parse(result.stdout);
        checkData("meal remove", output.data);
        expect(output.data.status).toBe(flag === "--yes" ? "committed" : "preview");
        expect(output.data.entry.name).toBe("Synthetic breakfast");
        expect(output.data.caloriesRemovedKcal).toBe(80);
        expect(output.data.consumedCaloriesAfterKcal).toBe(0);
        expect(output.data.mobileVerified).toBe(false);
        expect(result.stdout).not.toContain(token);
        expect(result.stdout).not.toContain("synthetic-device-marker");
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }, 40_000);
  test("built removal reports absent IDs as a no-op", async () => {
    const result = await cli(
      ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--item-id", "absent", "--yes"],
      { auth: true, mock: true },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    checkData("meal remove", output.data);
    expect(output.data.status).toBe("already-absent");
    expect(output.data.fieldsChanged).toEqual([]);
    expect(output.data.consumedCaloriesAfterKcal).toBe(80);
  });
  test("missing credentials fail promptly with empty stdout", async () => {
    const result = await cli(["premium"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(errorEnvelope(JSON.parse(result.stderr))).toBe(true);
    expect(JSON.parse(result.stderr).error.code).toBe("AUTH_REQUIRED");
  });
  test("doctor reports failed health and nonzero exit", async () => {
    const result = await cli(["doctor"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.data.healthy).toBe(false);
    checkData("doctor", output.data);
  });
  test("empty stdin never prompts", async () => {
    const result = await cli(["premium", "--token-stdin"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("AUTH_REQUIRED");
  });
  test.each(
    [
      ["food", "list", "--country", "peru"],
      ["food", "list", "--limit", "0"],
      ["food", "list", "--limit", "501"],
      ["food", "list", "--query", ""],
      ["food", "list", "--query", "a", "--query", "b"],
      ["food", "list", "--token-stdin"],
      ["premium", "--dry-run"],
      ["premium", "--timeout", "0"],
      ["premium", "--timeout", "NaN"],
      ["premium", "--country", "pe"],
      ["capture", "inspect"],
      ["device", "inspect"],
      ["meal", "delete"],
      ["--unknown", "private-argument"],
      ["--token", "private-argument"],
      ["food", "search"],
      ["search", "--query", "a", "--limit", "51"],
      ["search", "--query", "a", "--language", "de"],
      ["food", "list", "--language", "en"],
      ["auth", "login"],
      ["auth", "login", "--wait", "0"],
      ["auth", "status", "--wait", "10"],
      ["meal", "get"],
      ["meal", "get", "--date", "2026-02-30"],
      ["meal", "log", "--date", "2026-08-30"],
      ["meal", "refresh", "--date", "2026-08-30"],
      ["meal", "refresh", "--yes"],
      ["meal", "refresh", "--date", "2026-08-30", "--dry-run", "--yes"],
      ["meal", "refresh", "--date", "2026-08-30", "--meal", "breakfast", "--yes"],
      ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--item-id", "existing"],
      ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--yes"],
      ["meal", "remove", "--date", "2026-08-30", "--item-id", "existing", "--yes"],
      ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--item-id", "*", "--yes"],
      ["meal", "remove", "--date", "2026-08-30", "--meal", "breakfast", "--item-id", "existing", "--dry-run", "--yes"],
      [
        "meal",
        "remove",
        "--date",
        "2026-08-30",
        "--meal",
        "breakfast",
        "--item-id",
        "existing",
        "--yes",
        "--calories",
        "80",
      ],
    ].map((args) => ({ args })),
  )("bad args return a structured error", async ({ args }) => {
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(errorEnvelope(JSON.parse(result.stderr))).toBe(true);
    expect(result.stderr).not.toContain("private-argument");
  });
  test("expired credential doesn't reach fetch", async () => {
    const result = await cli(["premium", "--token-stdin"], { input: "e30.eyJleHAiOjF9.sig", mock: true });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("AUTH_EXPIRED");
  });
});

test("human strings escape terminal and bidi control characters", () => {
  expect(safeText("Name\x1b[31m\n\u202Etest")).toBe("Name\\u001b[31m\\u000a\\u202etest");
});

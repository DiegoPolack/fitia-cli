import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { CliError } from "../packages/core/src/errors.ts";

const execute = promisify(execFile);
const BUNDLE = "com.ulisesolave.Fitia";
type JsonObject = Record<string, any>;
export type DeviceRunner = (args: string[], timeoutMs: number) => Promise<JsonObject>;

export const runDeviceTool: DeviceRunner = async (args, timeoutMs) => {
  if (process.platform !== "darwin")
    throw new CliError(
      "UNSUPPORTED_PLATFORM",
      "Device commands require macOS and Xcode.",
      "Run this development diagnostic from a Mac with Xcode installed.",
      5,
    );
  const dir = await mkdtemp(join(tmpdir(), "fitia-device-"));
  try {
    await chmod(dir, 0o700);
    const output = join(dir, "result.json");
    await execute(
      "xcrun",
      ["devicectl", ...args, "--json-output", output, "--quiet", "--timeout", String(Math.ceil(timeoutMs / 1000))],
      { timeout: timeoutMs + 1000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(await readFile(output, "utf8"));
    if (!result.result || typeof result.result !== "object") throw new Error("Missing device result");
    return result.result;
  } catch {
    throw new CliError(
      "DEVICE_ACCESS_FAILED",
      "Xcode could not complete the device request.",
      "Install Xcode, connect and unlock the iPhone, and accept pairing if prompted. App Store data containers may be inaccessible.",
      5,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export async function listDevices(timeoutMs: number, runner = runDeviceTool) {
  const result = await runner(["list", "devices"], timeoutMs);
  if (!Array.isArray(result.devices))
    throw new CliError(
      "DEVICE_RESPONSE_CHANGED",
      "Xcode returned an unexpected device list.",
      "Check your Xcode version.",
      5,
    );
  return {
    devices: result.devices
      .filter((d: JsonObject) => d.hardwareProperties?.deviceType === "iPhone")
      .map((d: JsonObject) => ({
        id: String(d.identifier),
        name: String(d.deviceProperties?.name ?? "iPhone"),
        model: String(d.hardwareProperties?.marketingName ?? d.hardwareProperties?.productType ?? "iPhone"),
        state: String(d.connectionProperties?.tunnelState ?? "unknown"),
      })),
  };
}

export async function inspectDevice(deviceId: string, timeoutMs: number, runner = runDeviceTool) {
  const result = await runner(
    ["device", "info", "apps", "--device", deviceId, "--include-default-apps", "--bundle-id", BUNDLE],
    timeoutMs,
  );
  if (!Array.isArray(result.apps))
    throw new CliError(
      "DEVICE_RESPONSE_CHANGED",
      "Xcode returned an unexpected app list.",
      "Check your Xcode version.",
      5,
    );
  const app = result.apps.find((a: JsonObject) => a.bundleIdentifier === BUNDLE);
  let container = { accessible: false, status: "not-installed" };
  if (app) {
    try {
      await runner(
        [
          "device",
          "info",
          "files",
          "--device",
          deviceId,
          "--domain-type",
          "appDataContainer",
          "--domain-identifier",
          BUNDLE,
          "--no-recurse",
        ],
        timeoutMs,
      );
      container = { accessible: true, status: "listing-succeeded" };
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      container = { accessible: false, status: "listing-failed" };
    }
  }
  return {
    deviceId,
    installed: !!app,
    app: app
      ? {
          bundleId: BUNDLE,
          version: String(app.version),
          build: String(app.bundleVersion),
          developerBuild: app.builtByDeveloper === true,
        }
      : null,
    container,
    limitations: [
      "Container checks list only the root. No app data is copied.",
      "App Store builds cannot simply be installed in iOS Simulator.",
      "A failed container listing does not prove that local data is absent.",
    ],
  };
}

function timeoutMs(value?: string) {
  const seconds = value === undefined ? 15 : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120)
    throw new CliError("INVALID_TIMEOUT", "Timeout must be between 1 and 120 seconds.", "For example, --timeout 30.");
  return seconds * 1000;
}

async function main() {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: { device: { type: "string" }, timeout: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const command = parsed.positionals.join(" ");
  let result: unknown;
  if (command === "list") result = await listDevices(timeoutMs(parsed.values.timeout));
  else if (command === "inspect") {
    const device = parsed.values.device?.trim();
    if (!device || device.startsWith("-") || device.length > 200)
      throw new CliError(
        "DEVICE_REQUIRED",
        "Choose an iPhone to inspect.",
        "Run bun run dev:device list, then bun run dev:device inspect --device <id>.",
      );
    result = await inspectDevice(device, timeoutMs(parsed.values.timeout));
  } else {
    throw new CliError(
      "UNKNOWN_COMMAND",
      "Expected device list or device inspect.",
      "Run bun run dev:device list or bun run dev:device inspect --device <id>.",
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main)
  main().catch((error) => {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("DEV_COMMAND_FAILED", "Device command failed.", "Check the arguments and retry.", 5);
    console.error(`${cliError.code}: ${cliError.message}\n${cliError.hint}`);
    process.exitCode = cliError.exitCode;
  });

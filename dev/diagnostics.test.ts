import { expect, test } from "bun:test";
import { CliError } from "../packages/core/src/errors.ts";
import { inspectHar } from "./capture.ts";
import { type DeviceRunner, inspectDevice, listDevices } from "./device.ts";

const entry = (url: string, status = 200) => ({
  request: {
    method: "GET",
    url,
    headers: [{ name: "authorization", value: "private-token" }],
    cookies: [{ name: "session", value: "private-cookie" }],
    postData: { text: JSON.stringify({ idToken: "private-token", foodId: 99 }) },
  },
  response: {
    status,
    content: { text: JSON.stringify({ meals: [{ name: "private-food" }], email: "private@example.invalid" }) },
  },
});

test("HAR summarizes routes without headers, cookies, query or body values", () => {
  const output = inspectHar({
    log: {
      entries: [
        entry("https://app.fitia.app/api/profiles/syntheticUser0000000000000001?auth=private-token"),
        entry("https://other.invalid/banking"),
      ],
    },
  });
  expect(output.included).toBe(1);
  expect(output.skipped).toBe(1);
  expect(output.routes[0]).toMatchObject({
    path: "/api/profiles/:id",
    queryKeys: ["auth"],
    requestFields: ["foodId", "idToken"],
    responseFields: ["email", "meals"],
  });
  const text = JSON.stringify(output);
  for (const secret of [
    "private-token",
    "private-cookie",
    "private-food",
    "private@example.invalid",
    "syntheticUser0000000000000001",
  ])
    expect(text).not.toContain(secret);
});

test("host filtering is exact and summaries group statuses", () => {
  const entries = [
    entry("https://app.fitia.app/api/test", 200),
    entry("https://app.fitia.app/api/test", 401),
    entry("https://app.fitia.app.attacker.invalid/api/test"),
    entry("https://firestore.googleapis.com/v1/projects"),
  ];
  expect(inspectHar({ log: { entries } }).routes[0]).toMatchObject({ count: 2, statuses: [200, 401] });
  expect(inspectHar({ log: { entries } }, "firestore.googleapis.com").included).toBe(1);
});

test("base64 response bodies produce field names only", () => {
  const item = entry("https://app.fitia.app/api/test");
  (item.response.content as any).encoding = "base64";
  item.response.content.text = Buffer.from('{"calories":999,"secret":"private"}').toString("base64");
  expect(inspectHar({ log: { entries: [item] } }).routes[0]?.responseFields).toEqual(["calories", "secret"]);
});

test("malformed HAR is rejected and unknown entries are skipped", () => {
  expect(() => inspectHar({})).toThrow();
  expect(() => inspectHar({ log: { entries: {} } })).toThrow();
  expect(inspectHar({ log: { entries: [null, {}, entry("invalid-url")] } })).toMatchObject({ included: 0, skipped: 3 });
});

test("encoded email, dates, JWTs and control sequences in paths are generalized", () => {
  const paths = ["person%40example.com", "2026-08-30", "eyJ.secret.signature", "%1B%5B31m"];
  const result = inspectHar({ log: { entries: paths.map((p) => entry(`https://app.fitia.app/api/${p}`)) } });
  expect(result.routes).toHaveLength(1);
  expect(result.routes[0]?.path).toBe("/api/:id");
});

test("device list filters other devices and does not return serial numbers", async () => {
  const runner: DeviceRunner = async () => ({
    devices: [
      {
        identifier: "phone-id",
        hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 15", serialNumber: "private" },
        deviceProperties: { name: "Phone" },
        connectionProperties: { tunnelState: "connected" },
      },
      { identifier: "watch-id", hardwareProperties: { deviceType: "appleWatch" } },
    ],
  });
  const result = await listDevices(100, runner);
  expect(result.devices).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private");
});

test("device inspection constrains app scope and handles denied container", async () => {
  const runner: DeviceRunner = async (args) => {
    expect(args).toContain("com.ulisesolave.Fitia");
    if (args.includes("apps"))
      return {
        apps: [
          { bundleIdentifier: "com.ulisesolave.Fitia", version: "1", bundleVersion: "2", builtByDeveloper: false },
        ],
      };
    expect(args).toContain("--no-recurse");
    throw new CliError("DEVICE_ACCESS_FAILED", "Failed", "Unlock", 5);
  };
  expect(await inspectDevice("phone-id", 100, runner)).toMatchObject({
    installed: true,
    container: { accessible: false, status: "listing-failed" },
  });
});

test("missing app does not attempt container access", async () => {
  let calls = 0;
  const runner: DeviceRunner = async () => {
    calls++;
    return { apps: [] };
  };
  expect(await inspectDevice("phone-id", 100, runner)).toMatchObject({ installed: false, app: null });
  expect(calls).toBe(1);
});

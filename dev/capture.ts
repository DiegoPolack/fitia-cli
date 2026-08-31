import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CliError } from "../packages/core/src/errors.ts";

type Obj = Record<string, unknown>;
const record = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const badCapture = () =>
  new CliError(
    "INVALID_CAPTURE",
    "Expected a HAR file with log.entries.",
    "Export the narrow Fitia session as HAR and pass --file. Do not paste credentials into chat.",
  );

function safeKey(key: string) {
  return /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(key) && !/eyJ[A-Za-z0-9_-]{12}|AIza[A-Za-z0-9_-]{12}/.test(key)
    ? key
    : "<redacted>";
}

function jsonFields(text: unknown, encoding?: unknown): string[] {
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
  try {
    const value = JSON.parse(encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text);
    const item = Array.isArray(value) ? value[0] : value;
    return Object.keys(record(item)).slice(0, 50).map(safeKey).sort();
  } catch {
    return [];
  }
}

function safePath(pathname: string): string {
  // Prefer losing specificity over exposing user IDs, document IDs, or path tokens.
  return pathname
    .split("/")
    .map((part) => {
      if (!part) return "";
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return ":redacted";
      }
      if (!/^[a-zA-Z][a-zA-Z_-]{0,23}(?::[a-zA-Z]{1,24})?$/.test(decoded)) return ":id";
      return decoded;
    })
    .join("/");
}

export function inspectHar(input: unknown, host?: string) {
  const entries = record(record(input).log).entries;
  if (!Array.isArray(entries)) throw badCapture();
  const routes = new Map<
    string,
    {
      method: string;
      origin: string;
      path: string;
      statuses: number[];
      queryKeys: string[];
      requestFields: string[];
      responseFields: string[];
      count: number;
    }
  >();
  let included = 0;
  for (const raw of entries) {
    const entry = record(raw),
      request = record(entry.request),
      response = record(entry.response);
    let url: URL;
    try {
      url = new URL(String(request.url));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const allowed = host
      ? url.hostname === host
      : url.hostname === "app.fitia.app" ||
        url.hostname.endsWith(".fitia.app") ||
        url.hostname === "fitia.app" ||
        url.hostname === "fitia-27c84.firebaseapp.com" ||
        url.hostname.endsWith("-fitia-27c84.cloudfunctions.net");
    if (!allowed) continue;
    const method = String(request.method).toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) continue;
    included++;
    const path = safePath(url.pathname),
      key = `${method} ${url.origin}${path}`;
    const route = routes.get(key) ?? {
      method,
      origin: url.origin,
      path,
      statuses: [],
      queryKeys: [],
      requestFields: [],
      responseFields: [],
      count: 0,
    };
    route.count++;
    const status = response.status;
    if (Number.isInteger(status) && Number(status) >= 0 && Number(status) <= 599) route.statuses.push(status as number);
    route.queryKeys.push(...Array.from(url.searchParams.keys(), safeKey));
    const post = record(request.postData),
      content = record(response.content);
    route.requestFields.push(...jsonFields(post.text));
    if (Array.isArray(post.params))
      route.requestFields.push(...post.params.map((p) => safeKey(String(record(p).name))));
    route.responseFields.push(...jsonFields(content.text, content.encoding));
    routes.set(key, route);
  }
  for (const route of routes.values()) {
    route.statuses = [...new Set(route.statuses)].sort((a, b) => a - b);
    route.queryKeys = [...new Set(route.queryKeys)].sort();
    route.requestFields = [...new Set(route.requestFields)].sort();
    route.responseFields = [...new Set(route.responseFields)].sort();
  }
  return {
    entries: entries.length,
    included,
    skipped: entries.length - included,
    routes: [...routes.values()].sort((a, b) =>
      `${a.origin}${a.path}${a.method}`.localeCompare(`${b.origin}${b.path}${b.method}`),
    ),
    limitations: [
      "Local structural summary only. No requests are replayed.",
      "Header, cookie, query and body values are omitted. Dynamic path segments are generalized.",
      "Route names and field names are untrusted data and may still reveal context. Review before sharing.",
      "Default hosts exclude shared Google API hosts. Use --host for one exact hostname if needed.",
    ],
  };
}

export async function inspectCapture(file: string, host?: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw badCapture();
    const chunks: Buffer[] = [];
    let size = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > 50 * 1024 * 1024) throw badCapture();
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw badCapture();
    }
    return inspectHar(parsed, host);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "CAPTURE_READ_FAILED",
      "Could not read the capture file.",
      "Check the file path and permissions. The file contents were not printed.",
      5,
    );
  } finally {
    await handle?.close();
  }
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { file: { type: "string" }, host: { type: "string" } },
    strict: true,
  });
  const file = values.file?.trim();
  if (!file)
    throw new CliError(
      "FILE_REQUIRED",
      "A HAR file is required.",
      "Run bun run dev:capture --file /absolute/path/to/capture.har.",
    );
  if (values.host && !/^(?=.{1,253}$)[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/.test(values.host))
    throw new CliError(
      "INVALID_HOST",
      "Expected one hostname, not a URL or wildcard.",
      "For example, --host firestore.googleapis.com.",
    );
  console.log(JSON.stringify(await inspectCapture(file, values.host?.toLowerCase()), null, 2));
}

if (import.meta.main)
  main().catch((error) => {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("DEV_COMMAND_FAILED", "Capture command failed.", "Check the arguments and retry.", 5);
    console.error(`${cliError.code}: ${cliError.message}\n${cliError.hint}`);
    process.exitCode = cliError.exitCode;
  });

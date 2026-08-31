#!/usr/bin/env bun
import { keychain, sessionCredentials } from "@fitia/core";

async function readCode(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Pipe the one-time link code through stdin");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > 512) throw new Error("Link code input is too large");
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(input)) throw new Error("Invalid one-time link code");
  return input;
}

async function main() {
  const base = process.argv[2] ?? process.env.FITIA_MCP_URL;
  if (!base) throw new Error("Pass the remote MCP HTTPS URL or set FITIA_MCP_URL");
  const endpoint = new URL("/link/complete", base);
  if (endpoint.protocol !== "https:") throw new Error("Remote linking requires HTTPS");
  const code = await readCode();
  const credentials = await sessionCredentials(keychain, true);
  const saved = await keychain.read();
  if (!credentials || !saved || saved.uid !== credentials.uid || saved.idToken !== credentials.token) {
    throw new Error("No verified Fitia Keychain session is available");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, session: saved }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("The remote server rejected the link request");
  process.stdout.write(`${JSON.stringify({ ok: true, linked: true })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Linking failed";
  process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
  process.exitCode = 1;
});

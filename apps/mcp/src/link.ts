#!/usr/bin/env bun
import { credentials, FitiaClient, sessionCredentials } from "@fitia/core";

// Only locally authored messages may reach the terminal. Provider errors and
// response headers are untrusted and can contain reflected credentials.
class LinkError extends Error {}

async function readCode(): Promise<string> {
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) {
    process.stderr.write("Paste the one-time link code (hidden), then press Enter: ");
    process.stdin.setRawMode(true);
  }
  return new Promise((resolve, reject) => {
    let input = "";
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("error", fail);
      if (interactive) {
        process.stdin.setRawMode(false);
        process.stderr.write("\n");
      }
      process.stdin.pause();
    };
    const fail = () => {
      cleanup();
      reject(new LinkError("Link code input failed or timed out"));
    };
    const finish = () => {
      cleanup();
      const code = input.trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) reject(new LinkError("Invalid one-time link code"));
      else resolve(code);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.includes("\x03")) return fail();
      input += text;
      if (input.length > 512) return fail();
      if (interactive && /[\r\n]/.test(text)) finish();
    };
    const timer = setTimeout(fail, 60_000);
    process.stdin.on("data", onData).once("end", finish).once("error", fail);
    process.stdin.resume();
  });
}

async function main() {
  const base = process.argv[2] ?? process.env.FITIA_MCP_URL;
  if (!base) throw new LinkError("Pass the remote MCP HTTPS URL or set FITIA_MCP_URL");
  const parsed = new URL(base);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/mcp")
    throw new LinkError("Use the exact HTTPS /mcp URL without credentials, query, or fragment");
  const endpoint = new URL("/link/complete", parsed);
  if (endpoint.protocol !== "https:") throw new LinkError("Remote linking requires HTTPS");
  const code = await readCode();
  const current = await sessionCredentials(credentials, true);
  const saved = await credentials.read();
  if (!current || !saved || saved.uid !== current.uid || saved.idToken !== current.token) {
    throw new LinkError("No verified Fitia renewable session is available");
  }
  const account = await new FitiaClient(current.token).account();
  if (account.id !== saved.uid) throw new LinkError("Local Fitia account verification failed");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, session: saved }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new LinkError("The remote server rejected the link request. Request a new code and verify the local login.");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, linked: true })}\n`);
}

main().catch((error) => {
  const message =
    error instanceof LinkError
      ? error.message
      : "Linking failed. Verify the endpoint and local login, then request a new link code.";
  process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
  process.exitCode = 1;
});

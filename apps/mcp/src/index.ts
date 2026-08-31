#!/usr/bin/env bun
import { keychain, sessionCredentials } from "@fitia/core";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

const timeoutMs = Number(process.env.FITIA_TIMEOUT_MS ?? 15_000);
const boundedTimeout =
  Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 120_000 ? timeoutMs : 15_000;

void serveStdio(async () => {
  const saved = process.env.FITIA_TOKEN === undefined ? await sessionCredentials(keychain, true) : undefined;
  return createServer({
    token: process.env.FITIA_TOKEN ?? saved?.token,
    trustedAccountId: saved?.uid,
    timeoutMs: boundedTimeout,
  });
});

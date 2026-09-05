import { spawn } from "node:child_process";
import { CliError } from "./errors.ts";

const SERVICE = "io.cueva.fitia-cli";
const ACCOUNT = "session";

import { type SavedSession, type SessionStore, validSession } from "./credential-types.ts";

export type { SavedSession, SessionStore } from "./credential-types.ts";

function security(args: string[], input?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 65536) child.kill();
    });
    // Never expose security's diagnostics: its interactive mode may echo secrets.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(keychainError());
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function keychainError() {
  return new CliError(
    "KEYCHAIN_ERROR",
    "Could not access the Fitia CLI session in macOS Keychain.",
    "Unlock your login keychain, or use FITIA_TOKEN / --token-stdin. No plaintext fallback is used.",
    5,
  );
}

export function keychainStore(service = SERVICE, account = ACCOUNT): SessionStore {
  if (!/^[A-Za-z0-9.-]+$/.test(service) || !/^[A-Za-z0-9.-]+$/.test(account)) throw keychainError();
  return {
    name: "macos-keychain",
    async read() {
      if (process.platform !== "darwin") return undefined;
      const result = await security(["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (result.code === 44) return undefined;
      if (result.code !== 0) throw keychainError();
      try {
        const data = JSON.parse(Buffer.from(result.output.trim(), "base64").toString("utf8"));
        if (!validSession(data)) throw Error();
        return data as SavedSession;
      } catch {
        throw keychainError();
      }
    },
    async save(session) {
      if (process.platform !== "darwin")
        throw new CliError(
          "KEYCHAIN_UNAVAILABLE",
          "Saved login currently requires macOS Keychain.",
          "Use FITIA_TOKEN or --token-stdin on other systems.",
          5,
        );
      // Base64 contains no interactive-command delimiters. The secret travels over
      // stdin, never argv, a shell, a file, or the CLI's output streams.
      const encoded = Buffer.from(JSON.stringify(session)).toString("base64");
      const result = await security(["-i"], `add-generic-password -U -a ${account} -s ${service} -w ${encoded}\n`);
      if (result.code !== 0) throw keychainError();
      const saved = await this.read();
      if (!saved || JSON.stringify(saved) !== JSON.stringify(session)) throw keychainError();
    },
    async remove() {
      if (process.platform !== "darwin") return;
      const result = await security(["delete-generic-password", "-a", account, "-s", service]);
      if (result.code !== 0 && result.code !== 44) throw keychainError();
    },
  };
}
export const keychain = keychainStore();

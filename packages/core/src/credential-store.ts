import type { SessionStore } from "./credential-types.ts";
import { CliError } from "./errors.ts";
import { keychain } from "./keychain.ts";
import { windowsCredentialStore } from "./windows-credentials.ts";

export * from "./credential-types.ts";

export function credentialStore(platform: NodeJS.Platform = process.platform): SessionStore {
  if (platform === "darwin") return keychain;
  if (platform === "win32") return windowsCredentialStore();
  return {
    name: "unavailable",
    async read() {
      return undefined;
    },
    async save() {
      throw new CliError(
        "CREDENTIAL_STORE_UNAVAILABLE",
        "Renewable login requires Windows or macOS.",
        "Use an explicit temporary environment or stdin token on this platform. No plaintext fallback is used.",
        5,
      );
    },
    async remove() {},
  };
}

export const credentials = credentialStore();

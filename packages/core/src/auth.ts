import { CliError } from "./errors.ts";

export function cleanToken(input: string | undefined): string | undefined {
  if (!input?.trim()) return undefined;
  const token = input.trim();
  if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new CliError(
      "INVALID_TOKEN",
      "Expected a raw Firebase ID token.",
      "Supply only the token through FITIA_TOKEN or --token-stdin, without a Bearer prefix.",
      3,
    );
  }
  return token;
}

export function tokenStatus(token: string | undefined, source: string, now = Date.now()) {
  if (!token) return { configured: false, source: "none", expiresAt: null, expired: null, verified: false };
  let expiresAt: string | null = null;
  let expired: boolean | null = null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
      expiresAt = new Date(claims.exp * 1000).toISOString();
      expired = claims.exp * 1000 <= now;
    }
  } catch {
    /* Decoding is diagnostic, never verification or authorization. */
  }
  return { configured: true, source, expiresAt, expired, verified: false };
}

export function requireToken(token?: string): string {
  if (!token)
    throw new CliError(
      "AUTH_REQUIRED",
      "A Fitia ID token is required.",
      "Run fitia auth login --wait 300, set FITIA_TOKEN, or use --token-stdin.",
      3,
    );
  if (tokenStatus(token, "memory").expired)
    throw new CliError(
      "AUTH_EXPIRED",
      "The supplied ID token has expired.",
      "Supply a fresh token, or unset FITIA_TOKEN to use a renewable Keychain session. Run fitia auth login --wait 300 if needed.",
      3,
    );
  return token;
}

export async function readTokenStdin(timeoutMs: number): Promise<string | undefined> {
  if (process.stdin.isTTY)
    throw new CliError(
      "TOKEN_STDIN_REQUIRED",
      "--token-stdin requires piped input.",
      "Pipe a token from your secret manager, or use a hidden shell read to set FITIA_TOKEN.",
      3,
    );
  return await new Promise((resolve, reject) => {
    let input = "";
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
    };
    const fail = (error: CliError) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > 16384)
        fail(new CliError("INVALID_TOKEN", "Token input is too large.", "Pipe only the Firebase ID token.", 3));
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(cleanToken(input));
      } catch (error) {
        reject(error);
      }
    };
    const onError = () =>
      fail(new CliError("STDIN_ERROR", "Could not read token input.", "Try FITIA_TOKEN instead.", 5));
    const timer = setTimeout(
      () =>
        fail(
          new CliError(
            "STDIN_TIMEOUT",
            "Timed out waiting for token input.",
            "Close the input pipe after sending the token.",
            3,
          ),
        ),
      timeoutMs,
    );
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError);
    process.stdin.resume();
  });
}

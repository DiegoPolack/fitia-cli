import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { credentialStore, type SavedSession, validSession } from "../packages/core/src/credential-store.ts";
import { windowsCredentialStore } from "../packages/core/src/windows-credentials.ts";

const session: SavedSession = {
  version: 1,
  idToken: `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.synthetic`,
  refreshToken: "synthetic-refresh-never-a-real-credential",
  uid: "synthetic-user",
  email: "josé@example.invalid",
};

test("credential backend selection has no plaintext fallback", () => {
  expect(credentialStore("win32").name).toBe("windows-dpapi");
  expect(credentialStore("darwin").name).toBe("macos-keychain");
  expect(credentialStore("linux").name).toBe("unavailable");
  expect(() => windowsCredentialStore("../session")).toThrow();
});

test("stored credentials reject malformed data and secret-sized input", () => {
  expect(validSession(session)).toBe(true);
  for (const value of [
    null,
    {},
    { ...session, version: 2 },
    { ...session, uid: "" },
    { ...session, refreshToken: "bad token" },
    { ...session, idToken: "x".repeat(16385) },
  ]) {
    expect(validSession(value)).toBe(false);
  }
});

test.skipIf(process.platform !== "win32")(
  "native DPAPI save/read/rotation/delete and ciphertext tampering",
  async () => {
    const name = `test-${randomUUID()}`;
    const store = windowsCredentialStore(name);
    const path = join(process.env.LOCALAPPDATA!, "FitiaCLI", `${name}.dpapi`);
    try {
      expect(await store.read()).toBeUndefined();
      await store.save(session);
      expect(await store.read()).toEqual(session);
      const ciphertext = await readFile(path);
      expect(ciphertext.includes(Buffer.from(session.refreshToken))).toBe(false);
      expect(ciphertext.includes(Buffer.from(session.idToken))).toBe(false);
      const rotated = { ...session, refreshToken: "synthetic-rotated" };
      await store.save(rotated, session);
      await expect(store.save(session, session)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_ERROR" });
      expect(await store.read()).toEqual(rotated);
      ciphertext[ciphertext.length - 1] ^= 1;
      await writeFile(path, ciphertext);
      await expect(store.read()).rejects.toMatchObject({ code: "CREDENTIAL_STORE_ERROR" });
      await store.remove();
      expect(await store.read()).toBeUndefined();
      await expect(store.save(rotated, session)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_ERROR" });
      await store.remove();
    } finally {
      await store.remove();
    }
  },
  30000,
);

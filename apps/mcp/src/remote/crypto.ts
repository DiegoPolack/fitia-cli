const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(value: string): Uint8Array {
  const normalized = value
    .replace(/[\r\n]/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export const base64ToBytes = decodeBase64;

export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importEncryptionKey(encoded: string): Promise<CryptoKey> {
  const raw = decodeBase64(encoded);
  if (raw.byteLength !== 32) throw new Error("FITIA_SESSION_ENCRYPTION_KEY must contain 32 base64-encoded bytes");
  return crypto.subtle.importKey("raw", Uint8Array.from(raw).buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown, associatedData: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: Uint8Array.from(iv).buffer, additionalData: encoder.encode(associatedData) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptJson<T>(key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array, associatedData: string) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(iv).buffer,
      additionalData: Uint8Array.from(encoder.encode(associatedData)).buffer,
    },
    key,
    Uint8Array.from(ciphertext).buffer,
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function randomCode(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashCode(code: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(code)));
}

import { cleanToken, requireToken, tokenStatus } from "@fitia/core/runtime";
import { neon } from "@neondatabase/serverless";
import { base64ToBytes, bytesToBase64, decryptJson, encryptJson, hashCode } from "./crypto.ts";

const FIREBASE_KEY = "AIzaSyDuydfUsIFGRZttSiB3mEy0yBwAnnAa2yA";
const FIREBASE_PROJECT = "fitia-27c84";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;
const FIREBASE_JWKS = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";
const FITIA = "https://app.fitia.app";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export interface FitiaSession {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly uid: string;
  readonly email: string | null;
}

interface StoredRow {
  clerk_user_id: string;
  fitia_account_id: string;
  ciphertext_base64: string;
  iv_base64: string;
  expires_at: Date;
  version: string;
}

interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number;
}

export interface DatabaseClient {
  query<Row>(sql: string, parameters?: unknown[]): Promise<QueryResult<Row>>;
}

export interface DatabaseRunner {
  run<A>(use: (client: DatabaseClient) => Promise<A>): Promise<A>;
}

export function neonDatabase(connectionString: string): DatabaseRunner {
  const sql = neon(connectionString, { fullResults: true });
  return {
    run: (use) =>
      use({
        query: async <Row>(query: string, parameters: unknown[] = []) => {
          const result = await sql.query(query, parameters, {
            fullResults: true,
            fetchOptions: { signal: AbortSignal.timeout(10_000) },
          });
          return result as QueryResult<Row>;
        },
      }),
  };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 65_536) throw new Error("response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function validateSession(value: FitiaSession, allowExpired = false): FitiaSession {
  const cleaned = cleanToken(value.idToken);
  const idToken = allowExpired ? cleaned : requireToken(cleaned);
  if (idToken === undefined) throw new Error("Invalid Fitia ID token");
  if (
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length === 0 ||
    value.refreshToken.length > 16_384 ||
    /[\x00-\x20]/.test(value.refreshToken) ||
    typeof value.uid !== "string" ||
    value.uid.length === 0 ||
    !(value.email === null || typeof value.email === "string")
  ) {
    throw new Error("Invalid Fitia session");
  }
  return { ...value, idToken };
}

export async function verifyFirebaseIdToken(idToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const segments = idToken.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0 || segment.length > 16_384))
    throw new Error("Fitia account verification failed");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(textDecoder.decode(base64ToBytes(segments[0] as string)));
    claims = JSON.parse(textDecoder.decode(base64ToBytes(segments[1] as string)));
  } catch {
    throw new Error("Fitia account verification failed");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0)
    throw new Error("Fitia account verification failed");

  let response: Response;
  try {
    response = await fetcher(FIREBASE_JWKS, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("Firebase signing key fetch failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Firebase signing key response rejected");
  }
  const result = await boundedJson(response).catch(() => {
    throw new Error("Firebase signing key response invalid");
  });
  if (!Array.isArray(result.keys)) throw new Error("Fitia account verification failed");
  const jwk = result.keys.find(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "kid" in value &&
      value.kid === header.kid &&
      "alg" in value &&
      value.alg === "RS256" &&
      "kty" in value &&
      value.kty === "RSA",
  );
  if (!jwk) throw new Error("Fitia account verification failed");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new Error("Fitia account verification failed");
  }
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(base64ToBytes(segments[2] as string)).buffer,
    textEncoder.encode(`${segments[0]}.${segments[1]}`),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (
    !verified ||
    claims.iss !== FIREBASE_ISSUER ||
    claims.aud !== FIREBASE_PROJECT ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 128 ||
    !Number.isSafeInteger(claims.exp) ||
    (claims.exp as number) <= now ||
    !Number.isSafeInteger(claims.iat) ||
    (claims.iat as number) > now + 300
  )
    throw new Error("Fitia account verification failed");
  return claims.sub;
}

async function verifyProfile(idToken: string, uid: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${FITIA}/api/profiles/${encodeURIComponent(uid)}`, {
      headers: { Authorization: idToken, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Fitia profile verification request failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Fitia profile verification request failed");
  }
  const profile = await boundedJson(response).catch(() => {
    throw new Error("Fitia profile verification request failed");
  });
  if (Object.keys(profile).length === 0) throw new Error("Fitia profile verification failed");
}

async function refresh(session: FitiaSession): Promise<FitiaSession> {
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }).toString(),
    // Cloudflare Workers supports manual redirects; a 3xx remains non-ok and
    // is rejected without forwarding the renewable credential.
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Fitia session refresh was rejected");
  }
  const result = await boundedJson(response);
  const next = validateSession({
    ...session,
    idToken: result.id_token,
    refreshToken: result.refresh_token,
    uid: result.user_id,
  } as FitiaSession);
  if (next.uid !== session.uid) throw new Error("Fitia account changed during refresh");
  if ((await verifyFirebaseIdToken(next.idToken)) !== session.uid) throw new Error("Fitia account verification failed");
  return next;
}

function expiry(idToken: string): Date {
  const value = tokenStatus(idToken, "remote").expiresAt;
  if (value === null) throw new Error("Fitia ID token has no expiry");
  return new Date(value);
}

export class SessionRepository {
  private readonly database: DatabaseRunner;

  constructor(
    connectionString: string,
    private readonly encryptionKey: CryptoKey,
    database?: DatabaseRunner,
    private readonly refreshSession: (session: FitiaSession) => Promise<FitiaSession> = refresh,
    private readonly verifyIdentity = verifyFirebaseIdToken,
    private readonly verifyExistingProfile = verifyProfile,
  ) {
    this.database = database ?? neonDatabase(connectionString);
  }

  private run<A>(use: (client: DatabaseClient) => Promise<A>): Promise<A> {
    return this.database.run(use);
  }

  async createLinkCode(clerkUserId: string, code: string): Promise<void> {
    const digest = await hashCode(code);
    await this.run((client) =>
      client.query(
        `WITH deleted AS (
           DELETE FROM fitia_link_codes WHERE expires_at <= now()
         )
         INSERT INTO fitia_link_codes (code_hash, clerk_user_id, expires_at)
         VALUES (decode($2, 'base64'), $1, now() + interval '10 minutes')
         ON CONFLICT (clerk_user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at, created_at = now()`,
        [clerkUserId, bytesToBase64(digest)],
      ),
    );
  }

  async consumeLinkCode(code: string, input: FitiaSession): Promise<void> {
    const digest = await hashCode(code);
    const session = validateSession(input);
    const resolved = await this.run((database) =>
      database.query<{ clerk_user_id: string }>(
        "SELECT clerk_user_id FROM fitia_link_codes WHERE code_hash = decode($1, 'base64') AND expires_at > now()",
        [bytesToBase64(digest)],
      ),
    );
    const clerkUserId = resolved.rows[0]?.clerk_user_id;
    if (!clerkUserId) throw new Error("Link code is invalid or expired");
    const accountId = await this.verifyIdentity(session.idToken);
    await this.verifyExistingProfile(session.idToken, accountId);
    if (accountId !== session.uid) throw new Error("Fitia account verification failed");
    const bound = await encryptJson(this.encryptionKey, session, `${clerkUserId}:${accountId}`);
    const consumed = await this.run((database) =>
      database.query<{ clerk_user_id: string }>(
        `WITH consumed AS (
           DELETE FROM fitia_link_codes
           WHERE code_hash = decode($1, 'base64') AND clerk_user_id = $2 AND expires_at > now()
           RETURNING clerk_user_id
         )
         INSERT INTO fitia_sessions (clerk_user_id, fitia_account_id, ciphertext, iv, expires_at)
         SELECT clerk_user_id, $3, decode($4, 'base64'), decode($5, 'base64'), $6 FROM consumed
         ON CONFLICT (clerk_user_id) DO UPDATE SET fitia_account_id = EXCLUDED.fitia_account_id,
           ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, expires_at = EXCLUDED.expires_at,
           version = fitia_sessions.version + 1, updated_at = now()
         RETURNING clerk_user_id`,
        [
          bytesToBase64(digest),
          clerkUserId,
          accountId,
          bytesToBase64(bound.ciphertext),
          bytesToBase64(bound.iv),
          expiry(session.idToken),
        ],
      ),
    );
    if (consumed.rowCount !== 1) throw new Error("Link code is invalid or expired");
  }

  async load(clerkUserId: string, retries = 0): Promise<FitiaSession | undefined> {
    if (retries > 3) throw new Error("Fitia session changed repeatedly; retry the request");
    const row = await this.run(async (client) => {
      const result = await client.query<StoredRow>(
        `SELECT clerk_user_id, fitia_account_id, encode(ciphertext, 'base64') AS ciphertext_base64,
           encode(iv, 'base64') AS iv_base64, expires_at, version
         FROM fitia_sessions WHERE clerk_user_id = $1`,
        [clerkUserId],
      );
      return result.rows[0];
    });
    if (!row) return undefined;
    const saved = validateSession(
      await decryptJson<FitiaSession>(
        this.encryptionKey,
        base64ToBytes(row.ciphertext_base64),
        base64ToBytes(row.iv_base64),
        `${clerkUserId}:${row.fitia_account_id}`,
      ),
      true,
    );
    if (saved.uid !== row.fitia_account_id) throw new Error("Stored Fitia account mismatch");
    if (row.expires_at.getTime() > Date.now() + 60_000) return saved;

    let next: FitiaSession;
    try {
      next = validateSession(await this.refreshSession(saved));
    } catch {
      // A concurrent refresh may have rotated the credential while this request
      // was in flight. Reload only if the stored version actually changed.
      const latest = await this.run((client) =>
        client.query<{ version: string }>("SELECT version FROM fitia_sessions WHERE clerk_user_id = $1", [clerkUserId]),
      );
      if (latest.rows[0] && String(latest.rows[0].version) !== String(row.version))
        return this.load(clerkUserId, retries + 1);
      throw new Error("Fitia session refresh failed; reconnect the account if retrying fails");
    }
    if (next.uid !== saved.uid) throw new Error("Fitia account changed during refresh");
    const encrypted = await encryptJson(this.encryptionKey, next, `${clerkUserId}:${row.fitia_account_id}`);
    const updated = await this.run((client) =>
      client.query(
        `UPDATE fitia_sessions SET ciphertext = decode($1, 'base64'), iv = decode($2, 'base64'), expires_at = $3,
           version = version + 1, updated_at = now()
         WHERE clerk_user_id = $4 AND version = $5`,
        [
          bytesToBase64(encrypted.ciphertext),
          bytesToBase64(encrypted.iv),
          expiry(next.idToken),
          clerkUserId,
          row.version,
        ],
      ),
    );
    if (updated.rowCount === 1) return next;
    return this.load(clerkUserId, retries + 1);
  }
}

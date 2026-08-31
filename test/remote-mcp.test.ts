import { expect, test } from "bun:test";
import { InMemoryTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/server";
import { createRemoteApp, type RemoteEnv } from "../apps/mcp/src/remote/app.ts";
import {
  base64ToBytes,
  bytesToBase64,
  decryptJson,
  encryptJson,
  importEncryptionKey,
} from "../apps/mcp/src/remote/crypto.ts";
import { type DatabaseRunner, type FitiaSession, SessionRepository } from "../apps/mcp/src/remote/sessions.ts";
import { createServer } from "../apps/mcp/src/server.ts";

const env = {
  ALLOWED_HOSTS: "api.example.test",
  ALLOWED_ORIGINS: "https://app.example.test",
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_JWT_KEY: "unused-by-public-routes",
  DATABASE_URL: "postgres://unused",
  FITIA_SESSION_ENCRYPTION_KEY: "unused-by-public-routes",
  MCP_RESOURCE: "https://api.example.test/mcp",
} as RemoteEnv;

test("remote root renders the Markdown landing page", async () => {
  const response = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/", { headers: { Host: "api.example.test" } }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await response.text()).toContain("<h1>Fitia CLI</h1>");
});

test("remote MCP publishes path-aware OAuth metadata", async () => {
  const response = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/.well-known/oauth-protected-resource/mcp", {
      headers: { Host: "api.example.test" },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    resource: "https://api.example.test/mcp",
    authorization_servers: ["https://clerk.example.test"],
    scopes_supported: ["fitia:read", "fitia:write"],
  });
});

test("remote MCP advertises Clerk dynamic client registration", async () => {
  const response = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/.well-known/oauth-authorization-server", {
      headers: { Host: "api.example.test" },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    issuer: "https://clerk.example.test",
    registration_endpoint: "https://clerk.example.test/oauth/register",
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none", "client_secret_post"],
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "public_metadata",
      "private_metadata",
      "offline_access",
      "fitia:read",
      "fitia:write",
    ],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });
});

test("remote MCP challenges missing bearer credentials", async () => {
  const response = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "api.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp"',
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("remote boundary rejects unconfigured hosts and origins", async () => {
  const wrongHost = await createRemoteApp(env).fetch(new Request("https://other.example.test/health"));
  expect(wrongHost.status).toBe(403);
  const wrongOrigin = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/health", { headers: { Origin: "https://evil.example.test" } }),
  );
  expect(wrongOrigin.status).toBe(403);
});

test("read-only grants cannot discover write tools", async () => {
  const server = createServer({ token: "", canWrite: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();
  const receive = () =>
    new Promise<Record<string, any>>((resolve) => {
      clientTransport.onmessage = (message) => resolve(message as Record<string, any>);
    });

  let response = receive();
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  await response;
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  response = receive();
  await clientTransport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (await response).result.tools;
  expect(tools).toHaveLength(9);
  expect(tools.some((tool: { name: string }) => tool.name === "fitia-meal-log")).toBe(false);
  expect(tools.some((tool: { name: string }) => tool.name === "fitia-meal-remove")).toBe(false);
  await clientTransport.close();
});

function idToken(exp: number, marker: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp, marker })}.c2lnbmF0dXJl`;
}

test("concurrent Fitia refreshes cannot overwrite the winning credential", async () => {
  const key = await importEncryptionKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  const clerkUserId = "user_concurrency";
  const uid = "fitia-account";
  const initial: FitiaSession = {
    idToken: idToken(Math.floor(Date.now() / 1_000) - 60, "initial"),
    refreshToken: "initial-refresh",
    uid,
    email: null,
  };
  const encrypted = await encryptJson(key, initial, `${clerkUserId}:${uid}`);
  let row = {
    clerk_user_id: clerkUserId,
    fitia_account_id: uid,
    ciphertext_base64: bytesToBase64(encrypted.ciphertext),
    iv_base64: bytesToBase64(encrypted.iv),
    expires_at: new Date(0),
    version: "1",
  };
  let updates = 0;
  const database: DatabaseRunner = {
    run: async (use) =>
      use({
        query: async (sql: string, parameters: unknown[]) => {
          if (sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
          if (!sql.startsWith("UPDATE")) throw new Error("Unexpected query");
          updates += 1;
          if (row.version !== parameters[4]) return { rows: [], rowCount: 0 };
          row = {
            ...row,
            ciphertext_base64: parameters[0] as string,
            iv_base64: parameters[1] as string,
            expires_at: parameters[2] as Date,
            version: "2",
          };
          return { rows: [], rowCount: 1 };
        },
      } as never),
  };
  let refreshes = 0;
  let release!: () => void;
  const bothRefreshing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const repository = new SessionRepository("unused", key, database, async (saved) => {
    refreshes += 1;
    const marker = String(refreshes);
    if (refreshes === 2) release();
    await bothRefreshing;
    return {
      ...saved,
      idToken: idToken(Math.floor(Date.now() / 1_000) + 3600, marker),
      refreshToken: `descendant-${marker}`,
    };
  });

  const [first, second] = await Promise.all([repository.load(clerkUserId), repository.load(clerkUserId)]);
  expect(refreshes).toBe(2);
  expect(updates).toBe(2);
  expect(first?.idToken).toBe(second?.idToken);
  expect(first?.refreshToken).toBe(second?.refreshToken);
});

test("encrypted sessions are bound to one Clerk and Fitia identity", async () => {
  const key = await importEncryptionKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  const encrypted = await encryptJson(key, { refreshToken: "secret" }, "user_a:fitia_a");
  await expect(decryptJson(key, encrypted.ciphertext, encrypted.iv, "user_b:fitia_a")).rejects.toThrow();
  await expect(decryptJson(key, encrypted.ciphertext, encrypted.iv, "user_a:fitia_b")).rejects.toThrow();
});

test("session bytea values use a runtime-neutral base64 SQL boundary", () => {
  const value = crypto.getRandomValues(new Uint8Array(32));
  expect(base64ToBytes(bytesToBase64(value))).toEqual(value);
});

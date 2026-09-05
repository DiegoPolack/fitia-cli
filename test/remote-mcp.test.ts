import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { InMemoryTransport } from "../apps/mcp/node_modules/@modelcontextprotocol/server";
import { createRemoteApp, type RemoteEnv } from "../apps/mcp/src/remote/app.ts";
import { clerkTokenVerifier } from "../apps/mcp/src/remote/auth.ts";
import {
  base64ToBytes,
  bytesToBase64,
  decryptJson,
  encryptJson,
  importEncryptionKey,
} from "../apps/mcp/src/remote/crypto.ts";
import {
  type DatabaseRunner,
  type FitiaSession,
  SessionRepository,
  verifyFirebaseIdToken,
} from "../apps/mcp/src/remote/sessions.ts";
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

test("real signed OAuth JWTs enforce scopes and private user admission before database access", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (scope: string, sub = "user_owner") => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({ iss: env.CLERK_ISSUER, aud: env.MCP_RESOURCE, sub, scope, client_id: "client", iat: now, nbf: now - 1, exp: now + 60 })}`;
    return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  };
  const verifier = clerkTokenVerifier({ issuer: env.CLERK_ISSUER, audience: env.MCP_RESOURCE, jwtKey });
  expect((await verifier.verifyAccessToken(token("fitia:read"))).scopes).toEqual(["fitia:read"]);
  const app = createRemoteApp({ ...env, CLERK_JWT_KEY: jwtKey, ALLOWED_CLERK_USERS: "user_owner" });
  const request = (bearer: string) =>
    app.fetch(
      new Request(`${env.MCP_RESOURCE}`, {
        method: "POST",
        headers: { Host: "api.example.test", Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
  expect((await request(token("fitia:write"))).status).toBe(403);
  expect((await request(token("fitia:read", "user_stranger"))).status).toBe(403);
  expect((await request(`${token("fitia:read")}tampered`)).status).toBe(401);
});

test("OAuth verifier rejects wrong issuer, audience, identity and expired claims", async () => {
  const valid = {
    iss: env.CLERK_ISSUER,
    aud: env.MCP_RESOURCE,
    sub: "user_valid",
    exp: Math.floor(Date.now() / 1000) + 60,
    client_id: "client",
    scope: "fitia:read",
  };
  for (const patch of [
    { iss: "https://evil.invalid" },
    { aud: "https://other.invalid/mcp" },
    { aud: [env.MCP_RESOURCE] },
    { sub: "other" },
    { exp: 1 },
    { client_id: "" },
  ]) {
    const verifier = clerkTokenVerifier({
      issuer: env.CLERK_ISSUER,
      audience: env.MCP_RESOURCE,
      jwtKey: "unused",
      verify: (async () => ({ ...valid, ...patch })) as never,
    });
    await expect(verifier.verifyAccessToken("synthetic")).rejects.toMatchObject({ code: "invalid_token" });
  }
});

test("remote auth accepts Clerk OAuth access-token JWTs", async () => {
  let headerType: unknown;
  const verifier = clerkTokenVerifier({
    issuer: "https://clerk.example.test",
    audience: "https://api.example.test/mcp",
    jwtKey: "public-key",
    verify: (async (_token: string, options: { headerType?: string | string[] }) => {
      headerType = options.headerType;
      return {
        iss: "https://clerk.example.test",
        aud: "https://api.example.test/mcp",
        sub: "user_example",
        exp: Math.floor(Date.now() / 1_000) + 60,
        client_id: "oauth-client",
        scope: "fitia:read offline_access",
      };
    }) as never,
  });

  const auth = await verifier.verifyAccessToken("oauth-access-token");
  expect(headerType).toBe("at+jwt");
  expect(auth.scopes).toEqual(["fitia:read", "offline_access"]);
});

test("remote root renders the Markdown landing page", async () => {
  const response = await createRemoteApp(env).fetch(
    new Request("https://api.example.test/", { headers: { Host: "api.example.test" } }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const policy = response.headers.get("content-security-policy");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("font-src https://fonts.gstatic.com");
  const html = await response.text();
  expect(html).toContain("<h1>Fitia CLI</h1>");
  expect(html).toContain('font-family: "Space Grotesk", sans-serif');
  expect(html).toContain('<svg class="grain"');
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
    scopes_supported: ["openid", "profile", "email", "offline_access", "fitia:read", "fitia:write"],
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
  expect(response.headers.get("www-authenticate")).toContain('scope="fitia:read"');
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

test("read-only grants discover write tools and receive a scope-upgrade challenge", async () => {
  let linkStarted = false;
  const server = createServer({
    token: "",
    canWrite: false,
    resourceMetadataUrl: "https://api.example.test/.well-known/oauth-protected-resource/mcp",
    startLink: async () => {
      linkStarted = true;
      return { code: "one-time-code", expiresInSeconds: 600 };
    },
  });
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
  expect(tools).toHaveLength(13);
  expect(tools.find((tool: { name: string }) => tool.name === "fitia-account-link")._meta.securitySchemes).toEqual([
    { type: "oauth2", scopes: ["fitia:read"] },
  ]);
  const writeTool = tools.find((tool: { name: string }) => tool.name === "fitia-meal-log");
  expect(writeTool._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["fitia:read", "fitia:write"] }]);

  response = receive();
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "fitia-auth-status", arguments: {} },
  });
  const staleClientLink = (await response).result;
  expect(staleClientLink.isError).toBe(true);
  expect(JSON.parse(staleClientLink.content[0].text)).toMatchObject({
    error: { code: "FITIA_LINK_REQUIRED" },
    link: { code: "one-time-code", expiresInSeconds: 600 },
  });

  response = receive();
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "fitia-meal-log",
      arguments: {
        date: "2026-08-31",
        meal: "breakfast",
        name: "Scope test",
        caloriesKcal: 1,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        confirm: false,
      },
    },
  });
  const denied = (await response).result;
  expect(denied.isError).toBe(true);
  expect(denied._meta["mcp/www_authenticate"]).toEqual([
    'Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp", scope="fitia:write", error="insufficient_scope", error_description="This tool requires fitia:write"',
  ]);

  response = receive();
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "fitia-account-link", arguments: {} },
  });
  const linked = (await response).result;
  expect(linkStarted).toBe(true);
  expect(JSON.parse(linked.content[0].text)).toEqual({ code: "one-time-code", expiresInSeconds: 600 });

  await clientTransport.close();
});

function idToken(exp: number, marker: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp, marker })}.c2lnbmF0dXJl`;
}

test("Firebase ID tokens are verified offline against Google's public key", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "test-key" });
  const claims = encode({
    iss: "https://securetoken.google.com/fitia-27c84",
    aud: "fitia-27c84",
    sub: "fitia-user",
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 3600,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const token = `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test-key", alg: "RS256" };
  const fetcher = ((_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    return Promise.resolve(Response.json({ keys: [jwk] }));
  }) as typeof fetch;

  expect(await verifyFirebaseIdToken(token, fetcher)).toBe("fitia-user");
  const tamperedClaims = encode({
    iss: "https://securetoken.google.com/fitia-27c84",
    aud: "fitia-27c84",
    sub: "other-user",
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 3600,
  });
  await expect(verifyFirebaseIdToken(`${header}.${tamperedClaims}.${token.split(".")[2]}`, fetcher)).rejects.toThrow(
    "Fitia account verification failed",
  );
});

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

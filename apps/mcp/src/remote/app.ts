import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  type AuthInfo,
  type AuthorizationServerMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { marked } from "marked";
import { createServer } from "../server.ts";
import { clerkTokenVerifier, clerkUserFrom } from "./auth.ts";
import { importEncryptionKey, randomCode } from "./crypto.ts";
import landing from "./landing.md";
import { type FitiaSession, SessionRepository } from "./sessions.ts";

export interface RemoteEnv {
  readonly ALLOWED_HOSTS: string;
  readonly ALLOWED_ORIGINS: string;
  readonly CLERK_ISSUER: string;
  readonly CLERK_JWT_KEY: string;
  readonly DATABASE_URL: string;
  readonly FITIA_SESSION_ENCRYPTION_KEY: string;
  readonly MCP_RESOURCE: string;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateBoundary(request: Request, env: RemoteEnv): Response | undefined {
  const url = new URL(request.url);
  if (!list(env.ALLOWED_HOSTS).includes(url.host)) return new Response("Forbidden", { status: 403 });
  const origin = request.headers.get("origin");
  if (origin !== null && !list(env.ALLOWED_ORIGINS).includes(origin)) return new Response("Forbidden", { status: 403 });
  return undefined;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function renderLanding(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="An unofficial CLI and MCP server for your own Fitia account.">
    <title>Fitia CLI</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      body { margin: 0; background: #f4f0e8; color: #191919; }
      main { width: min(42rem, calc(100% - 2rem)); margin: 0 auto; padding: 12vh 0 5rem; }
      h1 { font-size: clamp(2.5rem, 10vw, 5.5rem); letter-spacing: -0.08em; margin: 0 0 2rem; }
      h2 { margin-top: 3rem; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.12em; }
      p, li { line-height: 1.75; }
      a { color: inherit; text-decoration-thickness: 2px; text-underline-offset: 0.2em; }
      code { background: #e4ded2; padding: 0.15em 0.35em; border-radius: 0.2em; }
      pre { overflow-x: auto; padding: 1rem; background: #191919; color: #f4f0e8; border-radius: 0.35rem; }
      pre code { padding: 0; background: transparent; }
      @media (prefers-color-scheme: dark) {
        body { background: #191919; color: #eee9df; }
        code { background: #302f2c; }
        pre { background: #eee9df; color: #191919; }
      }
    </style>
  </head>
  <body><main>${marked.parse(landing)}</main></body>
</html>`;
}

async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 40_000) throw new Error("Request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 40_000) throw new Error("Request body too large");
  return JSON.parse(text);
}

export function createRemoteApp(env: RemoteEnv) {
  const resource = new URL(env.MCP_RESOURCE);
  if (resource.pathname !== "/mcp") throw new Error("MCP_RESOURCE must use the /mcp path");
  const issuer = env.CLERK_ISSUER.replace(/\/$/, "");
  const oauthMetadata: AuthorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
  };
  const metadataOptions = {
    oauthMetadata,
    resourceServerUrl: resource,
    scopesSupported: ["fitia:read", "fitia:write"],
    resourceName: "Fitia MCP",
  };
  const gate = requireBearerAuth({
    verifier: clerkTokenVerifier({ issuer, audience: resource.href, jwtKey: env.CLERK_JWT_KEY }),
    requiredScopes: ["fitia:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: list(env.ALLOWED_HOSTS).map((host) => new URL(`https://${host}`).hostname),
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((origin) => new URL(origin).hostname),
  });

  app.use("*", async (context, next) => {
    const rejected = validateBoundary(context.req.raw, env);
    if (rejected) return rejected;
    await next();
    context.res = noStore(context.res);
  });

  app.get("/", (context) => {
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    return context.html(renderLanding());
  });
  app.all("/.well-known/*", (context) => oauthMetadataResponse(context.req.raw, metadataOptions) ?? context.notFound());
  app.get("/health", (context) => context.json({ ok: true }));

  app.post("/link/start", async (context) => {
    const auth = await gate(context.req.raw);
    if (auth instanceof Response) return auth;
    const code = randomCode();
    const repository = new SessionRepository(
      env.DATABASE_URL,
      await importEncryptionKey(env.FITIA_SESSION_ENCRYPTION_KEY),
    );
    await repository.createLinkCode(clerkUserFrom(auth), code);
    return context.json({ code, expiresInSeconds: 600 });
  });

  app.post("/link/complete", async (context) => {
    try {
      const body = await boundedBody(context.req.raw);
      if (typeof body.code !== "string" || typeof body.session !== "object" || body.session === null) throw new Error();
      const repository = new SessionRepository(
        env.DATABASE_URL,
        await importEncryptionKey(env.FITIA_SESSION_ENCRYPTION_KEY),
      );
      await repository.consumeLinkCode(body.code, body.session as FitiaSession);
      return context.json({ linked: true });
    } catch {
      return context.json({ error: "The link request is invalid or expired" }, 400);
    }
  });

  app.all("/mcp", async (context) => {
    const auth = await gate(context.req.raw);
    if (auth instanceof Response) return auth;
    const repository = new SessionRepository(
      env.DATABASE_URL,
      await importEncryptionKey(env.FITIA_SESSION_ENCRYPTION_KEY),
    );
    const session = await repository.load(clerkUserFrom(auth));
    const handler = createMcpHandler(() =>
      createServer({
        token: session?.idToken,
        trustedAccountId: session?.uid,
        canWrite: auth.scopes.includes("fitia:write"),
      }),
    );
    const parsedBody = (context.var as { parsedBody?: unknown }).parsedBody;
    return handler.fetch(context.req.raw, { authInfo: auth as AuthInfo, parsedBody });
  });

  return app;
}

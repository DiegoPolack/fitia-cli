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
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=swap" rel="stylesheet">
    <style>
      :root {
        color-scheme: dark light;
        --background: #111111;
        --text-primary: #f8f7f2;
        --text-secondary: rgba(248, 247, 242, 0.86);
        --text-muted: rgba(248, 247, 242, 0.66);
        --text-faint: rgba(248, 247, 242, 0.5);
        --surface: rgba(248, 247, 242, 0.06);
        --border: rgba(248, 247, 242, 0.12);
        --link-decoration: rgba(248, 247, 242, 0.3);
        --page-glow: transparent;
        --grain-opacity: 0.2;
        font-family: "Space Grotesk", sans-serif;
        font-synthesis: none;
      }
      * { box-sizing: border-box; }
      html { min-height: 100%; background: var(--background); }
      body {
        min-height: 100vh;
        margin: 0;
        overflow-x: hidden;
        background:
          radial-gradient(circle at 50% -24%, var(--page-glow), transparent 48%),
          var(--background);
        color: var(--text-secondary);
        -webkit-font-smoothing: antialiased;
      }
      .grain {
        position: fixed;
        inset: 0;
        z-index: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        opacity: var(--grain-opacity);
        mix-blend-mode: soft-light;
      }
      main {
        position: relative;
        z-index: 1;
        width: min(44rem, calc(100% - 2.5rem));
        margin: 0 auto;
        padding: clamp(5rem, 12vh, 8rem) 0 5rem;
      }
      h1 {
        margin: 0 0 1.25rem;
        color: var(--text-primary);
        font-size: clamp(3.75rem, 11vw, 6rem);
        font-weight: 500;
        letter-spacing: -0.075em;
        line-height: 0.95;
      }
      h1 + p {
        max-width: 35rem;
        margin-bottom: 4.5rem;
        color: var(--text-muted);
        font-size: clamp(1rem, 2.6vw, 1.125rem);
        line-height: 1.7;
      }
      h2 {
        margin: 3.25rem 0 1rem;
        color: var(--text-faint);
        font-size: 0.75rem;
        font-weight: 500;
        letter-spacing: 0.08em;
        line-height: 1.5;
        text-transform: uppercase;
      }
      p, li { font-size: 0.9375rem; line-height: 1.8; }
      a {
        border-radius: 0.25rem;
        color: var(--text-primary);
        text-decoration-color: var(--link-decoration);
        text-underline-offset: 0.25em;
        transition: color 160ms ease, text-decoration-color 160ms ease;
      }
      a:hover { text-decoration-color: currentColor; }
      a:focus-visible { outline: 2px solid var(--text-muted); outline-offset: 3px; }
      code {
        border: 1px solid var(--border);
        border-radius: 0.25rem;
        background: var(--surface);
        padding: 0.15em 0.35em;
        color: var(--text-primary);
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 0.85em;
      }
      pre {
        overflow-x: auto;
        margin: 1.5rem 0;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--surface);
        padding: 1.125rem 1.25rem;
        color: var(--text-secondary);
      }
      pre code { border: 0; background: transparent; padding: 0; color: inherit; line-height: 1.65; }
      main > p:last-child { margin-top: 3rem; color: var(--text-faint); font-size: 0.75rem; }
      @media (prefers-color-scheme: dark) {
        :root { --page-glow: rgba(248, 247, 242, 0.025); }
      }
      @media (prefers-color-scheme: light) {
        :root {
          --background: #f4f0e8;
          --text-primary: #17130f;
          --text-secondary: rgba(23, 19, 15, 0.86);
          --text-muted: rgba(23, 19, 15, 0.68);
          --text-faint: rgba(23, 19, 15, 0.58);
          --surface: rgba(23, 19, 15, 0.045);
          --border: rgba(23, 19, 15, 0.13);
          --link-decoration: rgba(23, 19, 15, 0.36);
          --page-glow: rgba(231, 161, 93, 0.24);
          --grain-opacity: 0.055;
        }
        .grain { mix-blend-mode: multiply; }
      }
      @media (max-width: 47.99rem) {
        .grain { display: none; }
        h1 + p { margin-bottom: 3.5rem; }
      }
      @media (prefers-reduced-motion: reduce) {
        a { transition: none; }
      }
    </style>
  </head>
  <body>
    <svg class="grain" aria-hidden="true" focusable="false">
      <filter id="noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noise)" />
    </svg>
    <main>${marked.parse(landing)}</main>
  </body>
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
    revocation_endpoint: `${issuer}/oauth/token/revoke`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
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
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
  const metadataOptions = {
    oauthMetadata,
    resourceServerUrl: resource,
    scopesSupported: ["fitia:read", "fitia:write"],
    resourceName: "Fitia MCP",
  };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const verifier = clerkTokenVerifier({ issuer, audience: resource.href, jwtKey: env.CLERK_JWT_KEY });
  const gate = requireBearerAuth({
    verifier,
    requiredScopes: ["fitia:read"],
    resourceMetadataUrl,
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
      "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'",
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      const known = new Set([
        "Invalid Fitia ID token",
        "Invalid Fitia session",
        "Fitia account verification failed",
        "Fitia account verification request failed",
        "Firebase signing key fetch failed",
        "Firebase signing key response rejected",
        "Firebase signing key response invalid",
        "Fitia profile verification failed",
        "Fitia profile verification request failed",
        "Link code is invalid or expired",
      ]);
      const code =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      console.warn("[fitia-link] rejected", { reason: known.has(message) ? message : "unexpected", code });
      const linkError =
        message === "Firebase signing key fetch failed"
          ? "FIREBASE_KEYS_FETCH_FAILED"
          : message === "Firebase signing key response rejected"
            ? "FIREBASE_KEYS_HTTP_FAILED"
            : message === "Firebase signing key response invalid"
              ? "FIREBASE_KEYS_PARSE_FAILED"
              : message === "Fitia account verification request failed"
                ? "FITIA_ACCOUNT_VERIFICATION_FAILED"
                : message === "Fitia profile verification request failed"
                  ? "FITIA_PROFILE_VERIFICATION_FAILED"
                  : message === "Link code is invalid or expired"
                    ? "LINK_CODE_INVALID"
                    : "LINK_FAILED";
      context.header("X-Fitia-Link-Error", linkError);
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
    const clerkUserId = clerkUserFrom(auth);
    const session = await repository.load(clerkUserId);
    const handler = createMcpHandler(() =>
      createServer({
        token: session?.idToken,
        trustedAccountId: session?.uid,
        canWrite: auth.scopes.includes("fitia:write"),
        resourceMetadataUrl,
        startLink: async () => {
          const code = randomCode();
          await repository.createLinkCode(clerkUserId, code);
          return { code, expiresInSeconds: 600 };
        },
      }),
    );
    const parsedBody = (context.var as { parsedBody?: unknown }).parsedBody;
    return handler.fetch(context.req.raw, { authInfo: auth as AuthInfo, parsedBody });
  });

  return app;
}

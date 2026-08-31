# Remote MCP deployment

The remote endpoint is a Cloudflare Worker using Hono, Clerk OAuth, and a Neon PostgreSQL database through Neon's HTTP driver. Clerk authenticates the MCP caller. A separate encrypted Fitia Firebase session identifies the Fitia account used by tools.

## Security boundaries

- `POST /mcp` requires a Clerk OAuth token with `fitia:read` and an exact audience of the configured `MCP_RESOURCE`.
- Write tools declare `fitia:write` in their security metadata and remain discoverable to read-only grants so clients can request upgraded authorization. Their handlers recheck the permission and return an OAuth `insufficient_scope` challenge without running the operation when it is absent.
- A Clerk token is never forwarded to Fitia. Each Clerk user resolves only the row keyed by that Clerk user ID.
- Fitia ID and refresh tokens are encrypted with AES-256-GCM. The Clerk user ID and verified Fitia account ID are authenticated as associated data.
- Refresh rotation updates the encrypted row with a version compare-and-swap. A losing concurrent request reloads the winning row instead of overwriting it.
- Remote linking uploads a renewable Fitia refresh credential to this service. Deploy only if operators and users accept that trust boundary. Tokens must not enter URLs, argv, logs, telemetry, Clerk metadata, or fixtures.

## Infrastructure

1. Create a Neon database, set `DATABASE_URL` in the ignored root `.env`, then run `bun run --filter @fitia/mcp db:migrate`.
2. Replace the public values in `apps/mcp/wrangler.jsonc`.
3. Configure Clerk custom scopes `fitia:read` and `fitia:write`. Enable CIMD for supported clients and restrict admission to reviewed clients. If dynamic client registration is enabled, set Clerk's default scopes to `openid`, `profile`, `email`, `offline_access`, `fitia:read`, and `fitia:write`; ChatGPT's dynamically registered client otherwise fails authorization with `invalid_scope`.
4. Set `DATABASE_URL` to the Neon connection string as a Worker secret.
5. Set `CLERK_JWT_KEY` to the Clerk instance's PEM JWT public key.
6. Generate 32 random bytes, encode them as base64, and set `FITIA_SESSION_ENCRYPTION_KEY` as a Worker secret.
7. Run `bun run --filter @fitia/mcp build:worker`, then deploy with Wrangler after reviewing the rendered bindings.

Use `wrangler secret put DATABASE_URL`, `wrangler secret put CLERK_JWT_KEY`, and `wrangler secret put FITIA_SESSION_ENCRYPTION_KEY`; never place these values in `wrangler.jsonc`.

## Link an account

An authenticated application calls `POST /link/start` with a Clerk OAuth bearer token containing `fitia:read`. The response contains a 256-bit, single-use code valid for ten minutes.

On the Mac holding the Fitia Keychain session, pipe that code to the local linker:

```sh
printf '%s' "$FITIA_LINK_CODE" | fitia-mcp-link https://fitia.cueva.io/mcp
```

The linker refreshes the local session, then sends it in one bounded HTTPS request body to `/link/complete`. The server verifies both the Fitia account and profile before atomically consuming the code and storing the encrypted session. The hosted Worker never attempts Firebase browser login, avoiding dependence on Fitia's Firebase authorized-domain list.

## Public routes

- `GET /`: minimal project landing page rendered from Markdown.
- `POST /mcp`: stateless Streamable HTTP MCP endpoint.
- `GET /.well-known/oauth-protected-resource/mcp`: RFC 9728 protected-resource metadata.
- `GET /.well-known/oauth-authorization-server`: Clerk authorization-server compatibility metadata, including dynamic client registration for MCP clients such as ChatGPT.
- `GET /health`: configuration-free health response.
- `POST /link/start`: authenticated one-time code creation.
- `POST /link/complete`: one-time local session submission.

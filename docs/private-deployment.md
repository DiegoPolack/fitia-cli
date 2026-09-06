# Private Windows deployment

Repository: https://github.com/DiegoPolack/fitia-cli (branch `windows-private-mcp`).
Upstream baseline: `a41ebaaab58181cef9fa69d4d90bd9d96aa2f07f`.
Endpoint: **https://fitia-mcp.diegopolackl.workers.dev/mcp**.

## Current status

The Cloudflare Worker is deployed with all three required secrets. Neon schema
migrations are applied, and production Clerk OAuth discovery advertises DCR,
PKCE S256 and both Fitia scopes. Both required discovery endpoints and health
return HTTP 200. Unauthenticated MCP requests receive an OAuth challenge.
The custom alias https://fitia.polacklabs.com also serves this Worker; the
canonical OAuth resource remains the workers.dev MCP URL above.

Windows Google login succeeded and the renewable session is stored with DPAPI.
An expired ID token was refreshed automatically, verified against the same Fitia
identity, rotated, and persisted. Account, profile, Premium, Peru/Spanish food
search, meals, day summary, and safe suggestion handling were verified both
locally and from ChatGPT. The production connector owner completed OAuth and the
one-time local link; the deployed allowlist contains only that owner. The current
ChatGPT grant contains `fitia:read`, while `fitia:write` still requires reconnect.
Writes remain disabled during verification. No real Fitia diary mutation was made.

Provisioned resources:

- Cloudflare Worker: `fitia-mcp`, account `fa095e286d4b7effdb319c7cb45a8ba5`.
- Neon: `fitia-mcp`, project `delicate-forest-75606638`, AWS us-east-1,
  PostgreSQL 18, production branch, `neondb`; migrations 0000 and 0001 applied.
- Clerk: `Fitia MCP`, application `app_3ItY9QNK15mz9dUXRgakjWPpECF`, production
  instance `ins_3ItZVKRvkxSszuBxdtjGu05TajK`.
- Production issuer: https://clerk.fitia.polacklabs.com; account portal:
  https://accounts.fitia.polacklabs.com. Five Clerk CNAMEs are verified, and
  the Worker custom domain has valid HTTPS. No unrelated DNS was changed.
- Worker secrets: `DATABASE_URL`, `CLERK_JWT_KEY`,
  `FITIA_SESSION_ENCRYPTION_KEY`; values are never committed.


## Windows installation and login

Use Bun 1.3.14 (the declared packageManager), or a compatible newer version.
From the repository root in PowerShell:

```powershell
bun install --frozen-lockfile
bun run build
Push-Location apps/cli; bun link; Pop-Location
Push-Location apps/mcp; bun link; Pop-Location
```

Ensure `$HOME/.bun/bin` is on your user PATH; open a new terminal after adding it.
This machine's user PATH has been configured. Then:

```powershell
fitia auth login --wait 300
fitia auth status
fitia whoami
fitia profile get
fitia premium
fitia food search --query pollo --limit 5
fitia meal get --date YYYY-MM-DD
fitia day summary --date YYYY-MM-DD
```

Use the real local calendar date in the last two commands. Login opens a
localhost page. Click Continue with Google and select the existing Fitia account.
`--no-open --wait 300` prints the page URL instead. No unrelated browser storage
is inspected; Firebase uses in-memory persistence. Existing Fitia account/profile
verification must succeed before storage. ID tokens refresh automatically when
near expiry; refreshed credentials must resolve to the same Firebase account.

`fitia auth logout` removes only the local CLI session. It does **not** revoke an
already-linked remote session. Disconnect OAuth and remove the remote association
through an authorized maintenance migration when retiring the remote deployment.
Never send ID tokens or refresh tokens through chat.

## Storage model

- Windows: `%LOCALAPPDATA%/FitiaCLI/session.dpapi`, encrypted/authenticated by
  Windows DPAPI CurrentUser, with a private directory ACL. A named mutex and
  compare-and-swap protect refresh persistence against stale writes and logout
  races. Replacements are atomic. Native helper input uses anonymous stdin pipes;
  argv contains constant code only. No plaintext token file or fallback exists.
- macOS: original `io.cueva.fitia-cli` / `session` Keychain entry is preserved.
- Linux: renewable credential storage is currently unsupported. Explicit
  environment/stdin ID-token overrides remain available; never save them to files.
- Remote: separate encrypted row keyed by authenticated Clerk user, AES-256-GCM
  with random 96-bit IVs and Clerk user + Fitia account as associated data.
  Refresh uses version compare-and-swap; a concurrent loser reloads the winner.
- ChatGPT: receives only its OAuth credential and tool results, never Firebase
  credentials. Fitia and Clerk token trust domains remain separate.

DPAPI protects against other ordinary Windows users and copied ciphertext. It
cannot protect secrets from malware running as the same Windows user or an
administrator. Do not copy DPAPI files to migrate accounts; sign in normally.

## Reproduce or maintain the remote infrastructure

1. Sign in to the owner-controlled Clerk and Neon dashboards. Create a dedicated
   Clerk application and Neon PostgreSQL database for this service.
2. In Clerk OAuth applications, create and advertise `fitia:read` and `fitia:write`.
   Prefer CIMD with reviewed/pre-registered ChatGPT client metadata if enabled for
   the account; otherwise enable DCR. Match `CLERK_CIMD_ENABLED=1` and
   `CLERK_DCR_ENABLED=0` to a CIMD-only setup. DCR defaults to advertised for
   upstream compatibility; set `CLERK_DCR_ENABLED=1` only when enabled in Clerk.
3. Assign scopes to the OAuth client, not just discovery. Preserve the upstream
   DCR default-scopes configuration: `openid profile email offline_access
   fitia:read fitia:write`, so dynamically created ChatGPT clients can authorize.
   This permits requested grants; handlers still require the actual token's
   `fitia:write`, and every mutation separately requires `confirm:true`.
4. Configure the exact resource/audience as the MCP URL above. Require PKCE S256,
   consent and the exact redirect URI shown by ChatGPT's connector setup. Never
   use wildcard redirect URIs. Copy the Clerk issuer and PEM JWT public key.
5. Set `CLERK_ISSUER` in Wrangler public vars and `ALLOWED_CLERK_USERS` to the
   owner's actual `user_...` ID. The committed allowlist contains this deployment's verified owner; replace it
   with your own production owner ID for a separate deployment.
6. Set `DATABASE_URL` and `CLERK_JWT_KEY` using Wrangler secret prompts. The
   encryption key already exists: **do not replace it on ordinary redeployment**.
   No secret value belongs in Wrangler vars, Git, screenshots or documentation.
7. Apply Drizzle migrations with `bun run --filter @fitia/mcp db:migrate` using a
   privately supplied `DATABASE_URL`. Migrations create sessions, hashed link
   codes, durable operation locks and encrypted write-audit records. Do not
   manually create/edit production tables. Never put a connection string in argv.
8. Run `bun run check` and `bun run --filter @fitia/mcp build:worker`, then
   `bun x wrangler deploy --config apps/mcp/wrangler.jsonc`.
9. Verify discovery metadata, unauthorized challenges, owner OAuth, account link,
   and remote reads. Keep `FITIA_DISABLE_WRITES=1` during initial verification.

## Linking and ChatGPT

After OAuth works, add the exact MCP URL in ChatGPT's custom connector/plugin
setup and authorize with Clerk. Call `fitia-account-link` to obtain a random,
single-use code valid for 10 minutes. On the Windows PC:

```powershell
fitia-mcp-link https://fitia-mcp.diegopolackl.workers.dev/mcp
```

Paste the code into the hidden prompt. It expires locally after 60 seconds.
Piped stdin is also supported. Never append the code to the command or URL.
The linker refreshes expiring credentials, verifies the local identity and sends
one HTTPS body to `/link/complete`, refusing redirects. The Worker verifies the
Firebase signature/issuer/audience and Fitia profile, then atomically consumes
and persists the link. Obtain a new code after an uncertain linking result.

Validate account/profile, calories/protein remaining, today's meals, `pollo`
search and dinner suggestions in ChatGPT. Preview writes only. A real diary
mutation requires the owner's approval of the exact entry, date and quantities.
This deployment completed that link and verified the read flow from ChatGPT.
Reconnect and grant `fitia:write` before testing a mutation-tool preview.

## Write safety and recovery

`confirm:false` is the MCP default. Handlers require `fitia:write` independently
of tool annotations. The global `FITIA_DISABLE_WRITES=1` kill switch is checked
inside the coordinator. Only exact quick-entry IDs can be removed; no fuzzy
selection, guessed macros, whole-diary overwrite or unsupported food deletion.

The remote coordinator uses PostgreSQL locks and encrypted audits, not Worker
filesystem storage. Audits are persisted before provider dispatch. Conditional
Firestore field patches and readback remain in the shared core. An uncertain
write retains its lock without a timer-based unlock; inspect the exact diary and
encrypted audit before an authorized recovery migration. Reuse the same
idempotency key, never mint a new key to bypass uncertainty. Audit encryption uses
`audit:<clerkUserId>:<fitiaAccountId>:<auditId>` as associated data.

## Update from upstream

```powershell
git fetch upstream
git switch -c maintenance/upstream-update
git merge upstream/main
bun install --frozen-lockfile
bun run check
```

Keep the Windows credential interface/backend, private Worker vars and durable
journal migrations during conflict resolution. Review new migrations before
applying them. Push to origin and review CI before deployment. The upstream
remote must remain `https://github.com/crafter-station/fitia-cli.git`.

## Verification and limitations

Automated coverage includes native DPAPI lifecycle/tampering/CAS, refresh and
identity checks, localhost CSRF/deadline protection, signed OAuth JWT validation,
scopes, MCP schemas/preview semantics, PostgreSQL link expiry/single-use/isolation,
AES-GCM identity binding, refresh CAS and encrypted durable audits. CI covers
Windows/macOS/Linux; platform-native tests execute on their applicable OS.

The full 219-test suite passes locally using Bun 1.3.14, including a regression
test for Cloudflare's unbound global `fetch` requirement. The committed Windows
ACL correction passed the complete Ubuntu, Windows and macOS CI matrix; see the
latest run on the branch for the final Worker compatibility patch. Remote linking
and ChatGPT read validation pass. Live dinner suggestions correctly returned
`dietary-review-required` rather than bypassing saved dietary restrictions.
ChatGPT write-scope reconnection and a preview-only write-tool check remain.
macOS retains upstream's Keychain behavior; it has not been exercised on this
Windows machine. Live diary writes are intentionally untested. Native recipe
suggestions and database-linked writes remain upstream scope limitations.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Clerk OAuth configuration](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth),
[Windows DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata).

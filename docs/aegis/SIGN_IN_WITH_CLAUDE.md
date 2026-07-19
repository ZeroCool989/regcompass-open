# Sign in with Claude — Research, Design, Activation (D10)

Status: **built, gated off — waiting on Anthropic app approval** (see "Activation runbook").
Scope contract: `docs/review-2026-07/DECISIONS.md` → D10. Researched 2026-07-17/18.

> **Implementation note (2026-07):** the concrete implementation described below
> (`lib/aegis/claude-oauth.ts`, `/api/aegis/providers/claude-oauth/*`, DB-table
> token storage, runtime "deliberately not wired") has been superseded by the
> generic loopback OAuth module — `lib/aegis/oauth/**`, routes under
> `/api/aegis/oauth/[provider]/*`, tokens in `~/.regcompass-open/auth.json`,
> runtime wired via `lib/aegis/client.ts` (`withSubscription`). Setup:
> `docs/OAUTH_SETUP.md`. The **research verdict and the approval gate below are
> unchanged**: without Anthropic-issued client credentials the Claude card stays
> "Setup erforderlich", and no traffic runs over subscription tokens.

## Research verdict (read this first)

Users connecting their **Claude subscription** to RegCompass ("Mit Claude anmelden",
billed to the user's own Anthropic account) is a real, officially supported pattern —
but **only for apps Anthropic has approved**. As of July 2026 there is **no public,
self-service developer registration** for it:

1. **The official mechanism exists.** Third-party apps redirect users to
   `claude.ai/oauth/authorize?client_id=…` (standard OAuth; a live authorize surface
   with real client IDs is observable), and since early 2026 usage by such apps is
   billed to the user's prepaid **"extra usage credits"** balance
   (claude.ai → Settings → Usage), not to the app operator. Sources:
   [Claude third-party apps and billing](https://fazm.ai/blog/claude-third-party-apps),
   claude.ai OAuth authorize URLs in the wild.
2. **Registration is approval-gated.** Anthropic publishes no client-registration
   endpoint, no OAuth contract (scopes, token endpoint, API header form) for external
   clients, and no self-service app directory submission. Existing "Sign in with
   Claude" apps were onboarded through Anthropic partnership channels.
3. **Doing it without approval is prohibited and enforced.** Anthropic's usage policy
   (updated Feb 2026) states that third-party products must authenticate with **API
   keys** (Console) and that developers may **not** offer Claude.ai login or route
   requests through users' Free/Pro/Max credentials on their own. Enforcement is
   live: `sk-ant-oat01-*` OAuth tokens (e.g. from `claude setup-token`) are rejected
   by the API for third-party use since ~2026-02-20. Sources:
   [Claude Code authentication docs](https://code.claude.com/docs/en/authentication)
   (setup-token is for the user's own Claude Code use),
   [policy-change reporting](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/),
   [anthropics/claude-code#28091](https://github.com/anthropics/claude-code/issues/28091).

**Consequence for RegCompass:** we implement the complete connect/storage/refresh/
disconnect architecture now, but the feature stays in a **"Setup erforderlich"**
state until Anthropic issues RegCompass a client registration. We do NOT guess
undocumented endpoints or scopes, and we do NOT route AEGIS traffic over subscription
tokens before approval — both would violate the policy above and break without
notice. BYOK API keys (D4) remain the working self-serve path today.

## What is built (behind the gate)

| Piece | Where | State |
|---|---|---|
| Config gate | `lib/aegis/claude-oauth.ts` → `claudeOAuthStatus()` | `unconfigured` until env vars set |
| PKCE + state CSRF protection | `lib/aegis/claude-oauth.ts` | S256, state HMAC-bound to user + 10-min expiry, single-use via httpOnly cookie |
| Connect flow | `GET /api/aegis/providers/claude-oauth/start` → claude.ai → `GET /api/aegis/providers/claude-oauth/callback` | Live once configured |
| Token storage | `UserClaudeOAuth` table, AES-256-GCM via the BYOK master key | Tokens never logged, never sent to the browser |
| Refresh | `refreshAccessToken()` — standard `refresh_token` grant against the configured token endpoint | Live once configured |
| Disconnect | `DELETE /api/aegis/providers/claude-oauth` | Deletes the row (tokens gone) |
| Settings UI | "Claude-Abo verbinden" card in Konto → AI-Provider | Shows Setup-erforderlich / Verbinden / Verbunden states honestly |
| AEGIS runtime | **Deliberately NOT wired** | See below |

### Why AEGIS calls do not use the OAuth token yet

The header/endpoint contract for approved apps (Bearer vs x-api-key, required beta
headers, model access, rate/credit semantics) is **not publicly documented** — it is
part of what Anthropic provides at approval. Wiring a guessed contract into
`lib/aegis/client.ts` would be exactly the "build from blog posts" failure D10
forbids. The seam is marked in `resolveAnthropicCredential()` (provider-settings.ts):
today's resolution order stays `BYOK key → system key`; the OAuth connection is
stored and surfaced in the UI as "verbunden, noch nicht für AEGIS-Anfragen aktiv".

## Environment variables (all unset today)

| Var | Meaning | Source |
|---|---|---|
| `ANTHROPIC_OAUTH_CLIENT_ID` | RegCompass's registered client id | Issued by Anthropic at approval |
| `ANTHROPIC_OAUTH_CLIENT_SECRET` | Client secret (omit for public/PKCE-only clients) | Issued by Anthropic |
| `ANTHROPIC_OAUTH_AUTHORIZE_URL` | Authorize endpoint (default `https://claude.ai/oauth/authorize`) | Anthropic docs at approval |
| `ANTHROPIC_OAUTH_TOKEN_URL` | Token endpoint — **no default, we do not guess** | Anthropic docs at approval |
| `ANTHROPIC_OAUTH_SCOPES` | Space-separated scopes | Anthropic docs at approval |

`claudeOAuthStatus()` returns `ready` only when CLIENT_ID **and** TOKEN_URL are set.
The redirect URI is `${APP_BASE_URL}/api/aegis/providers/claude-oauth/callback` —
register exactly this with Anthropic (prod domain, plus preview if desired).

## Activation runbook (what Almir must do)

1. **Apply to Anthropic** for third-party app approval / "Sign in with Claude"
   registration: via [anthropic.com/contact-sales](https://www.anthropic.com/contact-sales)
   or the [Claude Partner Network](https://www.anthropic.com/news/services-track-partner-hub);
   describe RegCompass Open (a local-first regulatory assistant).
2. Receive: client_id (+ secret), authorize/token endpoints, scopes, and the API
   calling contract for subscription-billed requests.
3. Set the env vars above in Vercel (production + preview) and locally.
4. Wire the runtime seam in `resolveAnthropicCredential()` per the received contract
   (one focused PR: credential type `oauth`, header form per contract, refresh-on-401,
   German mapping for credit-exhaustion errors — skeleton + tests already exist).
5. Register the exact callback URL with Anthropic.
6. QA: connect → AEGIS turn on subscription billing → disconnect → fallback to
   BYOK/system. Then remove the "noch nicht aktiv" note in the UI.

## Failure honesty (already implemented)

- Unconfigured start → HTTP 409, German: "Setup erforderlich …" (never a broken redirect).
- State/PKCE mismatch or expiry → redirect to settings with `claude=error` and a
  German message; nothing stored.
- Token exchange failure → German message, nothing stored, no token material logged.
- Refresh failure marks `lastError` and the UI shows "Bitte neu verbinden".
- OpenAI/Google consumer subscriptions: **not possible by their rules** — API keys
  only; the UI must never suggest otherwise (see D10).

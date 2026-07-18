# BYOK — Bring Your Own Key (User AI Provider Credentials)

Users can store their own AI-provider API keys so AEGIS runs on their key and
budget instead of the system's `ANTHROPIC_API_KEY`. Settings live under
**Konto → AI-Provider** (`/account/providers`).

## Provider status matrix

| Provider | Stored | Live-validated on save | Powers AEGIS |
|---|---|---|---|
| Anthropic (Claude) | ✅ | ✅ (token-free `GET /v1/models` check; 401/403 → German error, key NOT stored) | ✅ |
| OpenAI | ✅ | ❌ (`lastValidatedAt` stays `null`) | ❌ — stored only; UI says "AEGIS-Runtime bleibt deaktiviert…" |
| Google Gemini | ✅ | ❌ (`lastValidatedAt` stays `null`) | ❌ — stored only |

AEGIS is Claude-native (tool loops, prompt caching, deterministic verify).
OpenAI/Google keys are accepted for storage so users can prepare, but the
runtime refuses to prefer them (`PATCH` returns `unsupported_provider`) until
tool-use/citation parity is actually implemented and verified for that
provider (decision D4, docs/review-2026-07/DECISIONS.md).

## Security model

- Keys are encrypted at rest with **AES-256-GCM** (`lib/aegis/provider-settings.ts`);
  master key = SHA-256 of `AEGIS_BYOK_ENCRYPTION_KEY` (env, ≥32 chars required in
  deployed envs — boot fails loud otherwise; insecure dev fallback only locally).
- API responses only ever contain a **masked** key (prefix + HMAC-fingerprint tail);
  the plaintext never reaches the client, tools, model text, or logs
  (`ToolContext.anthropicApiKey` is server-only; verified via log grep in testing).
- The BYOK Anthropic client cache is capped (50 instances, oldest evicted) so raw
  keys are not pinned unboundedly in warm serverless instances.
- All `/api/aegis/providers` routes require an authenticated, **approved** user;
  every query is scoped to `userId` (no cross-user access path).

## Runtime behaviour

- `resolveAnthropicCredential(userId)` in `runAegis`/`runAegisStreaming` selects the
  user's key; `null` (none stored/disabled) → system `ANTHROPIC_API_KEY` fallback.
- An **invalid user key at call time** (Anthropic 401) surfaces as a German,
  actionable `invalid_input` error pointing at Konto → AI-Provider — never as an
  "internal error". A **failed decrypt** (rotated master key) likewise.
- Haiku helper calls (triage/intent/compression) intentionally continue to use the
  **system key** — they cost fractions of a cent and keeping them on the system key
  means a broken user key can't take down triage. The main generation (Sonnet/Opus)
  runs on the user's key.
- Usage/cost logging is unchanged and still records per-user usage.

## Env vars

| Var | Purpose |
|---|---|
| `AEGIS_BYOK_ENCRYPTION_KEY` | Master secret for AES-256-GCM at-rest encryption (≥32 chars, required in deployed envs) |
| `ANTHROPIC_API_KEY` | System fallback key (unchanged) |

## Pre-merge deployment steps

1. Set `AEGIS_BYOK_ENCRYPTION_KEY` in Vercel (production + preview) BEFORE merging —
   deployed envs throw on save attempts without it.
2. `prisma db push` the `AiProvider`/`UserAiCredential` schema against **production**
   (dev branch `br-long-butterfly-alq4halh` already has it) — explicit post-merge step
   per epic decision P2.

## What remains for OpenAI/Google activation

- Model adapter layer (tool-use loop, streaming, usage accounting parity)
- Citation verify parity (deterministic verify assumes Anthropic response shapes)
- Per-provider cost tables in `lib/aegis/context/cost.ts`
- Only then: lift the `runtimeSupported`/`PATCH` guard.

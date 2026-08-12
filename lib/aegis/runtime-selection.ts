import { db } from '@/lib/db';
import {
  AegisError,
  modelFamily,
  type AegisMode,
  type ModelFamily,
  type ModelId,
} from './types';
import {
  AegisProviderKeyMissingError,
  AegisProviderNotConfiguredError,
  decryptApiKey,
  getAegisProvider,
  type UiLanguage,
} from './provider-settings';
import { applyModelPreference, routeToModel } from './router';

/**
 * Request-scoped provider selection — the authoritative, immutable answer to
 * "which brain runs THIS request, with which model and credential".
 *
 * Resolved ONCE per request from the user's stored `User.aegisProvider` (the
 * three-card selection). The result is frozen and threaded through the run; no
 * environment variable, model-id prefix, legacy `AEGIS_BRAIN` setting, or later
 * settings change may replace it (dispatch honours `selection.provider`
 * explicitly — see `getProviderFor` in the registry). There is NO silent
 * fallback: a selected-but-unusable provider throws a typed error rather than
 * quietly switching brains or credentials.
 *
 * Stage 1b-ii-b1 activates only `anthropic-api`. `gemini-api` is structurally
 * wired but D4-gated (capability-not-ready); `chatgpt-codex` is runtime-pending
 * (Stage 1b-ii-b2).
 */

/** The runtime brains that have (or will have) a real dispatch path. */
export type RuntimeProvider = 'anthropic' | 'gemini';

/** A provider-qualified model reference — carried end-to-end so a nominal Claude
 *  id can never flow through a Gemini request (and vice-versa). */
export type RuntimeModelRef = { provider: RuntimeProvider; model: string };

/**
 * The resolved credential for the selected provider. `source: 'user'` is a
 * decrypted BYOK key (may upgrade the model tier, D8); `source: 'system'` means
 * the provider falls back to its configured environment key (the app-level
 * key), carrying no secret in this object.
 */
export type RuntimeCredential =
  | { source: 'user'; apiKey: string; modelHint: string | null }
  | { source: 'system'; apiKey: null; modelHint: null };

/** Provider + credential, resolved early (fail-fast) and immutable. */
export type ProviderAccess = Readonly<{
  provider: RuntimeProvider;
  credential: RuntimeCredential;
}>;

/** The full immutable selection: provider + provider-qualified model + credential. */
export type RuntimeSelection = Readonly<{
  provider: RuntimeProvider;
  model: Readonly<RuntimeModelRef>;
  credential: RuntimeCredential;
}>;

// ───────────────────────── Typed errors (bilingual, AegisError-surfaced) ─────────────────────────

/** ChatGPT/Codex selected — its runtime is Stage 1b-ii-b2, not active yet. Never
 *  falls back to Anthropic or Gemini. */
export class AegisCodexRuntimePendingError extends AegisError {
  readonly kind = 'codex_runtime_pending' as const;
  constructor(language: UiLanguage = 'de') {
    super(
      'invalid_input',
      language === 'en'
        ? 'The ChatGPT/Codex runtime is not available yet. Please choose Claude API for now.'
        : 'Die ChatGPT/Codex-Laufzeit ist noch nicht verfügbar. Bitte vorerst Claude API wählen.',
    );
    this.name = 'AegisCodexRuntimePendingError';
  }
}

/** The exact capabilities Gemini must prove before dispatch is enabled (D4). */
export const GEMINI_MISSING_CAPABILITIES = [
  'tool_choice=none enforcement (forced tool-free repair/degrade passes)',
  'stable tool-call ids across the verify-retry / trimForRetry envelope',
  'non-fatal SAFETY/RECITATION finish handling',
  'upstream request cancellation on client disconnect',
  'demonstrated live tool-loop + KB-citation parity (unverified without a live run)',
] as const;

/** Gemini selected — structurally wired but D4-gated. Reports the exact missing
 *  capability set. Never falls back. */
export class AegisGeminiCapabilityNotReadyError extends AegisError {
  readonly kind = 'gemini_capability_not_ready' as const;
  readonly missingCapabilities = GEMINI_MISSING_CAPABILITIES;
  constructor(language: UiLanguage = 'de') {
    super(
      'invalid_input',
      language === 'en'
        ? 'Gemini is not yet enabled for AEGIS: the required tool-loop and citation guarantees are not verified (D4). Please choose Claude API.'
        : 'Gemini ist für AEGIS noch nicht freigeschaltet: Die erforderlichen Tool-/Zitations-Garantien sind nicht verifiziert (D4). Bitte Claude API wählen.',
    );
    this.name = 'AegisGeminiCapabilityNotReadyError';
  }
}

/** A stored Anthropic key that cannot be decrypted (rotated master key / corrupt
 *  ciphertext). A config problem the user resolves by re-entering the key. */
export class AegisProviderKeyUndecryptableError extends AegisError {
  readonly kind = 'key_undecryptable' as const;
  constructor(language: UiLanguage = 'de') {
    super(
      'invalid_input',
      language === 'en'
        ? 'Your stored Anthropic API key could not be decrypted. Please re-enter it under Account → AI provider.'
        : 'Ihr gespeicherter Anthropic API-Schlüssel konnte nicht entschlüsselt werden. Bitte unter Konto → AI-Provider neu speichern.',
    );
    this.name = 'AegisProviderKeyUndecryptableError';
  }
}

/** Programming invariant: a model id that does not belong to its provider must
 *  never reach dispatch. Internal (500) — indicates a routing bug, not user input. */
export class AegisProviderModelMismatchError extends AegisError {
  readonly kind = 'provider_model_mismatch' as const;
  constructor(ref: RuntimeModelRef) {
    super('internal_error', `Provider/model mismatch: provider "${ref.provider}" cannot run model "${ref.model}".`);
    this.name = 'AegisProviderModelMismatchError';
  }
}

// ───────────────────────── Model identity mapping ─────────────────────────

/**
 * How AEGIS task tiers map to Gemini model ids. The router picks a tier as a
 * Claude id (haiku/sonnet/opus); for a Gemini run that tier is translated to the
 * corresponding current Gemini 2.5 id. These are real, current identifiers — not
 * invented — and Gemini pricing stays `pricing_unknown` (types.ts) until a rate
 * is verified. Opus has no distinct Gemini analogue, so it maps to Pro (the
 * highest available), never below.
 */
const GEMINI_TIER_MODEL: Record<ModelFamily, string> = {
  haiku: 'gemini-2.5-flash',
  sonnet: 'gemini-2.5-pro',
  opus: 'gemini-2.5-pro',
};

/** Translate the router's (Claude-tier) decision into a provider-qualified ref. */
export function mapToRuntimeModel(provider: RuntimeProvider, routedModel: string): RuntimeModelRef {
  if (provider === 'anthropic') return { provider, model: routedModel };
  const fam = modelFamily(routedModel) ?? 'sonnet';
  return { provider: 'gemini', model: GEMINI_TIER_MODEL[fam] };
}

/**
 * The model id to hand the loop, typed as its `ModelId`. Stage 1b-ii-b1
 * dispatches only Anthropic (Gemini is gated in `resolveProviderAccess`, before
 * a selection is ever built for it), so the model is always a Claude `ModelId`
 * here; the assert makes that invariant explicit rather than a silent cast.
 * Widening the loop's `ModelId` signatures for real Gemini dispatch is b2.
 */
export function dispatchModelId(selection: RuntimeSelection): ModelId {
  if (selection.provider !== 'anthropic') {
    throw new AegisProviderModelMismatchError(selection.model);
  }
  return selection.model.model as ModelId;
}

/** Fail before dispatch if a model id does not belong to its provider. */
export function assertModelForProvider(ref: RuntimeModelRef): void {
  const ok =
    ref.provider === 'anthropic' ? ref.model.startsWith('claude') : ref.model.startsWith('gemini');
  if (!ok) throw new AegisProviderModelMismatchError(ref);
}

// ───────────────────────── Credential resolution (provider-isolated) ─────────────────────────

/**
 * Resolve the Anthropic credential — and ONLY the Anthropic credential. Prefers a
 * user's decrypted BYOK key; otherwise the app-level `ANTHROPIC_API_KEY` (the
 * downloadable default); otherwise a typed missing-key error. Never reads, loads,
 * or decrypts a Gemini/OpenAI/other-provider credential.
 */
async function resolveAnthropicCredential(userId: string, language: UiLanguage): Promise<RuntimeCredential> {
  const row = await db.userAiCredential.findUnique({
    where: { userId_provider: { userId, provider: 'ANTHROPIC' } },
  });
  if (row?.enabled) {
    let apiKey: string;
    try {
      apiKey = decryptApiKey(row.encryptedApiKey);
    } catch {
      throw new AegisProviderKeyUndecryptableError(language);
    }
    return { source: 'user', apiKey, modelHint: row.preferredModel };
  }
  const systemKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (systemKey) return { source: 'system', apiKey: null, modelHint: null };
  throw new AegisProviderKeyMissingError('anthropic-api', language);
}

// ───────────────────────── Resolution entry points ─────────────────────────

/**
 * Resolve provider + credential ONCE, early in the request (before any
 * conversation turn is persisted), so a misconfiguration fails fast. Reads only
 * the explicitly stored `User.aegisProvider` — `null` means "not configured" and
 * throws the typed error; there is NO "null means Anthropic" rule in the router.
 *
 * An explicit `directAnthropicKey` (internal/BYOK-override callers) pins
 * Anthropic with that key and bypasses the stored selection — the one sanctioned
 * non-user path, never triggered by env or model prefix.
 */
export async function resolveProviderAccess(params: {
  userId: string | null;
  language: UiLanguage;
  directAnthropicKey?: string | null;
}): Promise<ProviderAccess> {
  const direct = params.directAnthropicKey?.trim();
  if (direct) {
    const credential: RuntimeCredential = { source: 'user', apiKey: direct, modelHint: null };
    return Object.freeze({ provider: 'anthropic', credential });
  }

  const selected = params.userId ? await getAegisProvider(params.userId) : null;
  if (!selected) throw new AegisProviderNotConfiguredError(params.language);

  switch (selected) {
    case 'chatgpt-codex':
      throw new AegisCodexRuntimePendingError(params.language);
    case 'gemini-api':
      // D4 gate: structurally wired, dispatch disabled until parity is proven.
      throw new AegisGeminiCapabilityNotReadyError(params.language);
    case 'anthropic-api':
      return Object.freeze({
        provider: 'anthropic',
        credential: await resolveAnthropicCredential(params.userId!, params.language),
      });
  }
}

/**
 * Assemble the immutable, frozen `RuntimeSelection` from the early
 * provider/credential access plus the routed model (which needs the per-request
 * complexity, computed after memory start). The provider is fixed from
 * `resolveProviderAccess`; only the model tier is derived here. Guards
 * provider/model consistency before the selection is returned.
 */
export function buildRuntimeSelection(
  access: ProviderAccess,
  mode: AegisMode,
  complexity: number,
): RuntimeSelection {
  // applyModelPreference reads only `source`/`modelHint` (a BYOK tier upgrade);
  // pass those, not the credential's key material.
  const route = applyModelPreference(routeToModel(mode, complexity), {
    source: access.credential.source,
    modelHint: access.credential.modelHint,
  });
  const model = mapToRuntimeModel(access.provider, route.model);
  assertModelForProvider(model);
  return Object.freeze({
    provider: access.provider,
    model: Object.freeze(model),
    credential: access.credential,
  });
}

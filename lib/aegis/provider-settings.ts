import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { MODEL_IDS } from './types';

export type AegisAiProvider = 'ANTHROPIC' | 'OPENAI' | 'GOOGLE';

export const PROVIDER_LABELS: Record<AegisAiProvider, string> = {
  ANTHROPIC: 'Claude / Anthropic',
  OPENAI: 'OpenAI',
  GOOGLE: 'Google Gemini',
};

export const PROVIDER_DEFAULT_MODELS: Record<AegisAiProvider, string> = {
  ANTHROPIC: 'claude-sonnet-4-6',
  OPENAI: 'gpt-4.1',
  GOOGLE: 'gemini-2.5-pro',
};

const PROVIDERS = new Set<AegisAiProvider>(['ANTHROPIC', 'OPENAI', 'GOOGLE']);
const DEV_SECRET = 'regcompass-dev-insecure-byok-key-change-me';

function deployed(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
}

function masterKey(): Buffer {
  const raw = process.env.AEGIS_BYOK_ENCRYPTION_KEY;
  if (raw && raw.length >= 32) return createHash('sha256').update(raw).digest();
  if (deployed()) {
    throw new Error('AEGIS_BYOK_ENCRYPTION_KEY must be set (>=32 chars) before storing user AI credentials.');
  }
  return createHash('sha256').update(DEV_SECRET).digest();
}

export function parseProvider(value: unknown): AegisAiProvider | null {
  return typeof value === 'string' && PROVIDERS.has(value as AegisAiProvider)
    ? (value as AegisAiProvider)
    : null;
}

export function encryptApiKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptApiKey(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Unsupported credential ciphertext.');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function fingerprintApiKey(key: string): string {
  const secret = process.env.SESSION_SECRET ?? 'dev-fingerprint-secret';
  return createHmac('sha256', secret).update(key).digest('hex').slice(0, 16);
}

function masked(provider: AegisAiProvider, fingerprint: string): string {
  const prefix = provider === 'ANTHROPIC' ? 'sk-ant' : provider === 'OPENAI' ? 'sk' : 'AIza';
  return `${prefix}…${fingerprint.slice(-4)}`;
}

/**
 * Curated model choices for the ANTHROPIC provider (D8). Ids MUST stay in sync
 * with MODEL_IDS in ./types — the router only honors known ids. Structured
 * modes keep their quality floor: preferences upgrade, never downgrade
 * (lib/aegis/router.ts: applyModelPreference).
 */
export const ANTHROPIC_MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: MODEL_IDS.sonnet, label: 'Sonnet – Standard (empfohlen)' },
  { id: MODEL_IDS.opus, label: 'Opus – höchste Qualität, höhere Kosten' },
  { id: MODEL_IDS.haiku, label: 'Haiku – schnell und günstig' },
];

export const MODEL_PIN_NOTE =
  'Modi mit festem Qualitätsminimum (z. B. Kontroll-Empfehlungen: Opus) überstimmen Ihre Auswahl nach oben — nie nach unten.';

export type ProviderSettingsView = {
  preferredProvider: AegisAiProvider | null;
  providers: Array<{
    provider: AegisAiProvider;
    label: string;
    configured: boolean;
    enabled: boolean;
    maskedKey: string | null;
    preferredModel: string;
    /** Curated ids the user may pick for this provider; empty = free text. */
    modelOptions: Array<{ id: string; label: string }>;
    /** Shown next to the model picker when options exist. */
    modelNote: string | null;
    runtimeSupported: boolean;
    note: string;
    lastValidatedAt: string | null;
    lastValidationError: string | null;
  }>;
};

export async function listProviderSettings(userId: string): Promise<ProviderSettingsView> {
  const [user, rows] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { preferredAiProvider: true } }),
    db.userAiCredential.findMany({ where: { userId } }),
  ]);
  const byProvider = new Map(rows.map((r) => [r.provider as AegisAiProvider, r]));
  return {
    preferredProvider: (user?.preferredAiProvider as AegisAiProvider | null) ?? null,
    providers: (['ANTHROPIC', 'OPENAI', 'GOOGLE'] as AegisAiProvider[]).map((provider) => {
      const row = byProvider.get(provider);
      const runtimeSupported = provider === 'ANTHROPIC';
      return {
        provider,
        label: PROVIDER_LABELS[provider],
        configured: !!row,
        enabled: row?.enabled ?? false,
        maskedKey: row ? masked(provider, row.keyFingerprint) : null,
        preferredModel: row?.preferredModel ?? PROVIDER_DEFAULT_MODELS[provider],
        modelOptions: provider === 'ANTHROPIC' ? [...ANTHROPIC_MODEL_OPTIONS] : [],
        modelNote: provider === 'ANTHROPIC' ? MODEL_PIN_NOTE : null,
        runtimeSupported,
        note: runtimeSupported
          ? 'Kann für AEGIS verwendet werden. Tool-Nutzung, Prompt-Caching und Verifikation bleiben unverändert.'
          : 'Credential wird sicher gespeichert. AEGIS-Runtime bleibt deaktiviert, bis Tool-Use/Citation-Parität für diesen Provider verifiziert ist.',
        lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
        lastValidationError: row?.lastValidationError ?? null,
      };
    }),
  };
}

/**
 * Live-validate an Anthropic key with a token-free API call (models list).
 * Returns null when valid, otherwise a German, user-actionable error message.
 * Exported for tests; injectable fetch for mocking.
 */
export async function validateAnthropicKey(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403) {
      return 'Anthropic hat diesen API-Schlüssel abgelehnt. Bitte prüfen Sie den Schlüssel in der Anthropic Console.';
    }
    // Transient upstream trouble must not block saving a probably-good key;
    // record it as unvalidated instead of failing the request.
    return null;
  } catch {
    return null; // network trouble ≠ invalid key
  }
}

export async function upsertProviderCredential(params: {
  userId: string;
  provider: AegisAiProvider;
  apiKey: string;
  preferredModel?: string | null;
}): Promise<void> {
  const key = params.apiKey.trim();
  if (key.length < 12) throw new Error('Der API-Schlüssel ist zu kurz.');
  // Only Anthropic is runtime-active (D4) — validate those keys for real
  // before storing. OPENAI/GOOGLE are stored without validation and MUST
  // carry lastValidatedAt: null so the UI never implies a check that
  // didn't happen.
  let validatedAt: Date | null = null;
  if (params.provider === 'ANTHROPIC') {
    // D8: only curated model ids are storable — the router ignores unknown ids
    // anyway, but rejecting here keeps the stored state honest.
    const model = params.preferredModel?.trim();
    if (model && !ANTHROPIC_MODEL_OPTIONS.some((o) => o.id === model)) {
      throw new Error('Unbekanntes Modell. Bitte eines der angebotenen Modelle wählen.');
    }
    const validationError = await validateAnthropicKey(key);
    if (validationError) throw new Error(validationError);
    validatedAt = new Date();
  }
  const data = {
    encryptedApiKey: encryptApiKey(key),
    keyFingerprint: fingerprintApiKey(key),
    preferredModel: params.preferredModel?.trim() || PROVIDER_DEFAULT_MODELS[params.provider],
    enabled: true,
    lastValidatedAt: validatedAt,
    lastValidationError: null,
  };
  await db.userAiCredential.upsert({
    where: { userId_provider: { userId: params.userId, provider: params.provider as AegisAiProvider } },
    create: { userId: params.userId, provider: params.provider as AegisAiProvider, ...data },
    update: data,
  });
}

export async function setPreferredProvider(userId: string, provider: AegisAiProvider | null): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { preferredAiProvider: provider as AegisAiProvider | null } });
}

export async function deleteProviderCredential(userId: string, provider: AegisAiProvider): Promise<void> {
  await db.userAiCredential.deleteMany({ where: { userId, provider: provider as AegisAiProvider } });
  await db.user.updateMany({
    where: { id: userId, preferredAiProvider: provider as AegisAiProvider },
    data: { preferredAiProvider: null },
  });
}

export async function resolveAnthropicCredential(userId: string | null): Promise<{
  apiKey: string;
  modelHint: string | null;
  source: 'user' | 'system';
} | null> {
  // Credential resolution for the stored-key (BYOK) path. Connected
  // subscriptions are handled separately by the local OAuth module
  // (lib/aegis/oauth), whose token takes precedence over a stored key when the
  // active brain matches; see the registry wiring.
  if (!userId) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { preferredAiProvider: true } });
  if (user?.preferredAiProvider && user.preferredAiProvider !== 'ANTHROPIC') {
    throw new Error(`${PROVIDER_LABELS[user.preferredAiProvider as AegisAiProvider]} ist gespeichert, aber für AEGIS noch nicht runtime-freigegeben. Bitte Anthropic wählen oder System-Provider verwenden.`);
  }
  const row = await db.userAiCredential.findUnique({
    where: { userId_provider: { userId, provider: 'ANTHROPIC' } },
  });
  if (!row || !row.enabled) return null;
  let apiKey: string;
  try {
    apiKey = decryptApiKey(row.encryptedApiKey);
  } catch {
    // Master key rotated or ciphertext corrupted — actionable for the user,
    // and must never surface as an English internal error mid-conversation.
    throw new Error(
      'Ihr gespeicherter Anthropic API-Schlüssel konnte nicht entschlüsselt werden. Bitte speichern Sie ihn unter Konto → AI-Provider neu.',
    );
  }
  return { apiKey, modelHint: row.preferredModel, source: 'user' };
}

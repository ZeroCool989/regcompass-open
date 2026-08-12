import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable DB: getAegisProvider → user.findUnique; anthropic credential →
// userAiCredential.findUnique. No real Prisma.
const { mockUserFindUnique, mockCredFindUnique } = vi.hoisted(() => ({
  mockUserFindUnique: vi.fn(),
  mockCredFindUnique: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockUserFindUnique },
    userAiCredential: { findUnique: mockCredFindUnique },
  },
}));

import {
  AegisCodexRuntimePendingError,
  AegisGeminiCapabilityNotReadyError,
  AegisProviderModelMismatchError,
  assertModelForProvider,
  buildRuntimeSelection,
  dispatchModelId,
  mapToRuntimeModel,
  resolveProviderAccess,
  type ProviderAccess,
} from '../runtime-selection';
import {
  AegisProviderKeyMissingError,
  AegisProviderNotConfiguredError,
  encryptApiKey,
} from '../provider-settings';
import { MODEL_IDS } from '../types';

const SAVED = { ...process.env };
beforeEach(() => {
  mockUserFindUnique.mockReset();
  mockCredFindUnique.mockReset();
});
afterEach(() => {
  process.env = { ...SAVED };
});

/** Make getAegisProvider(userId) resolve to `value`. */
function selectionIs(value: string | null) {
  mockUserFindUnique.mockResolvedValue(value === null ? null : { aegisProvider: value });
}

describe('resolveProviderAccess — provider selection (resolved once, no fallback)', () => {
  it('anthropic-api → anthropic provider, system credential when only the env key exists', async () => {
    selectionIs('anthropic-api');
    mockCredFindUnique.mockResolvedValue(null); // no BYOK row
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system';
    const access = await resolveProviderAccess({ userId: 'u1', language: 'de' });
    expect(access.provider).toBe('anthropic');
    expect(access.credential).toEqual({ source: 'system', apiKey: null, modelHint: null });
    // Resolved from the stored selection exactly once.
    expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
  });

  it('anthropic-api with a stored BYOK key → decrypted user credential (only the ANTHROPIC row is read)', async () => {
    selectionIs('anthropic-api');
    mockCredFindUnique.mockResolvedValue({
      encryptedApiKey: encryptApiKey('sk-ant-user'),
      preferredModel: MODEL_IDS.opus,
      enabled: true,
    });
    const access = await resolveProviderAccess({ userId: 'u1', language: 'de' });
    expect(access.credential).toEqual({ source: 'user', apiKey: 'sk-ant-user', modelHint: MODEL_IDS.opus });
    // Never loads a non-selected provider's credential.
    expect(mockCredFindUnique).toHaveBeenCalledTimes(1);
    expect(mockCredFindUnique.mock.calls[0][0]).toMatchObject({
      where: { userId_provider: { userId: 'u1', provider: 'ANTHROPIC' } },
    });
  });

  it('anthropic-api with NO key at all → typed missing-key error (never a silent switch)', async () => {
    selectionIs('anthropic-api');
    mockCredFindUnique.mockResolvedValue(null);
    delete process.env.ANTHROPIC_API_KEY;
    await expect(resolveProviderAccess({ userId: 'u1', language: 'de' })).rejects.toBeInstanceOf(
      AegisProviderKeyMissingError,
    );
  });

  it('anthropic-api with an undecryptable stored key → typed error (does not fall back to the env key)', async () => {
    selectionIs('anthropic-api');
    mockCredFindUnique.mockResolvedValue({ encryptedApiKey: 'v1.bad.bad.bad', preferredModel: null, enabled: true });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system';
    await expect(resolveProviderAccess({ userId: 'u1', language: 'de' })).rejects.toThrow(/entschlüsselt|decrypt/i);
  });

  it('gemini-api → capability-not-ready, NEVER dispatched or fallen back to Anthropic', async () => {
    selectionIs('gemini-api');
    await expect(resolveProviderAccess({ userId: 'u1', language: 'de' })).rejects.toBeInstanceOf(
      AegisGeminiCapabilityNotReadyError,
    );
    // No credential of any provider is touched for a gated provider.
    expect(mockCredFindUnique).not.toHaveBeenCalled();
  });

  it('the Gemini error reports the exact missing capabilities (D4)', async () => {
    selectionIs('gemini-api');
    const err = await resolveProviderAccess({ userId: 'u1', language: 'en' }).catch((e) => e);
    expect(err).toBeInstanceOf(AegisGeminiCapabilityNotReadyError);
    expect(err.missingCapabilities.length).toBeGreaterThan(0);
    expect(err.message).toMatch(/D4/);
  });

  it('chatgpt-codex → runtime-pending, never another provider', async () => {
    selectionIs('chatgpt-codex');
    await expect(resolveProviderAccess({ userId: 'u1', language: 'de' })).rejects.toBeInstanceOf(
      AegisCodexRuntimePendingError,
    );
    expect(mockCredFindUnique).not.toHaveBeenCalled();
  });

  it('no stored selection → not-configured error; null is NEVER interpreted as Anthropic', async () => {
    selectionIs(null);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-system'; // a key exists, but selection is unset
    await expect(resolveProviderAccess({ userId: 'u1', language: 'de' })).rejects.toBeInstanceOf(
      AegisProviderNotConfiguredError,
    );
    // Router did not silently resolve to anthropic — no credential lookup happened.
    expect(mockCredFindUnique).not.toHaveBeenCalled();
  });

  it('a null userId is treated as not-configured (no implicit provider)', async () => {
    await expect(resolveProviderAccess({ userId: null, language: 'de' })).rejects.toBeInstanceOf(
      AegisProviderNotConfiguredError,
    );
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('an explicit directAnthropicKey pins Anthropic and bypasses the stored selection', async () => {
    // Even if the stored selection were gemini, the internal direct-key path is Anthropic.
    selectionIs('gemini-api');
    const access = await resolveProviderAccess({ userId: 'u1', language: 'de', directAnthropicKey: 'sk-ant-direct' });
    expect(access.provider).toBe('anthropic');
    expect(access.credential).toEqual({ source: 'user', apiKey: 'sk-ant-direct', modelHint: null });
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('bilingual: the not-configured message is localized', async () => {
    selectionIs(null);
    const de = await resolveProviderAccess({ userId: 'u1', language: 'de' }).catch((e) => e.message);
    const en = await resolveProviderAccess({ userId: 'u1', language: 'en' }).catch((e) => e.message);
    expect(de).toMatch(/ausgewählt/);
    expect(en).toMatch(/selected/);
  });
});

describe('model identity mapping + mismatch guard', () => {
  it('maps Anthropic tiers through unchanged (Claude ids)', () => {
    expect(mapToRuntimeModel('anthropic', MODEL_IDS.sonnet)).toEqual({ provider: 'anthropic', model: MODEL_IDS.sonnet });
  });

  it('maps AEGIS tiers to current Gemini ids (never an invented name, never Anthropic pricing reuse)', () => {
    expect(mapToRuntimeModel('gemini', MODEL_IDS.haiku)).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
    expect(mapToRuntimeModel('gemini', MODEL_IDS.sonnet)).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
    // Opus has no distinct Gemini analogue → Pro (highest), never below.
    expect(mapToRuntimeModel('gemini', MODEL_IDS.opus)).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('assertModelForProvider fails a provider/model mismatch before dispatch', () => {
    expect(() => assertModelForProvider({ provider: 'gemini', model: MODEL_IDS.sonnet })).toThrow(
      AegisProviderModelMismatchError,
    );
    expect(() => assertModelForProvider({ provider: 'anthropic', model: 'gemini-2.5-pro' })).toThrow(
      AegisProviderModelMismatchError,
    );
    expect(() => assertModelForProvider({ provider: 'anthropic', model: MODEL_IDS.sonnet })).not.toThrow();
  });
});

describe('buildRuntimeSelection — immutable, provider-consistent', () => {
  const systemAccess: ProviderAccess = Object.freeze({
    provider: 'anthropic',
    credential: { source: 'system' as const, apiKey: null, modelHint: null },
  });

  it('assembles a frozen selection with a provider-qualified Claude model', () => {
    const sel = buildRuntimeSelection(systemAccess, 'CONVERSATIONAL', 0.2);
    expect(sel.provider).toBe('anthropic');
    expect(sel.model.provider).toBe('anthropic');
    expect(sel.model.model.startsWith('claude')).toBe(true);
    expect(Object.isFrozen(sel)).toBe(true);
    expect(Object.isFrozen(sel.model)).toBe(true);
  });

  it('dispatchModelId returns the Claude ModelId for an Anthropic selection', () => {
    const sel = buildRuntimeSelection(systemAccess, 'ASSESS', 0.5);
    expect(dispatchModelId(sel)).toBe(sel.model.model);
  });

  it('a BYOK modelHint can upgrade the tier (D8), a system credential cannot', () => {
    const userAccess: ProviderAccess = Object.freeze({
      provider: 'anthropic',
      credential: { source: 'user' as const, apiKey: 'sk-ant', modelHint: MODEL_IDS.opus },
    });
    // CONVERSATIONAL low complexity routes to haiku; the user's opus hint upgrades it.
    expect(buildRuntimeSelection(userAccess, 'CONVERSATIONAL', 0.1).model.model).toBe(MODEL_IDS.opus);
    expect(buildRuntimeSelection(systemAccess, 'CONVERSATIONAL', 0.1).model.model).toBe(MODEL_IDS.haiku);
  });
});

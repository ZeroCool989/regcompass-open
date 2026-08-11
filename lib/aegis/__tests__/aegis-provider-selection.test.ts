import { describe, expect, it, vi } from 'vitest';
import {
  AEGIS_PROVIDERS,
  AegisProviderKeyMissingError,
  encryptApiKey,
  parseAegisProvider,
  selectCredentialFrom,
  validateGeminiKey,
} from '@/lib/aegis/provider-settings';

describe('Aegis provider selection', () => {
  it('exposes exactly the three card providers', () => {
    expect([...AEGIS_PROVIDERS]).toEqual(['chatgpt-codex', 'anthropic-api', 'gemini-api']);
  });

  it('parseAegisProvider accepts the three and rejects others', () => {
    expect(parseAegisProvider('chatgpt-codex')).toBe('chatgpt-codex');
    expect(parseAegisProvider('anthropic-api')).toBe('anthropic-api');
    expect(parseAegisProvider('gemini-api')).toBe('gemini-api');
    expect(parseAegisProvider('ANTHROPIC')).toBeNull();
    expect(parseAegisProvider('openai')).toBeNull();
    expect(parseAegisProvider(null)).toBeNull();
  });
});

describe('validateGeminiKey', () => {
  const okFetch = () => new Response('{}', { status: 200 });

  it('returns null for a valid key and sends the key in a header, not the URL', async () => {
    const fetchImpl = vi.fn(okFetch) as unknown as typeof fetch;
    expect(await validateGeminiKey('AIza-good', fetchImpl)).toBeNull();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).not.toContain('AIza-good'); // key never in URL
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'AIza-good' });
  });

  it('reports a rejected key on 400/401/403', async () => {
    for (const status of [400, 401, 403]) {
      const fetchImpl = (() => new Response('no', { status })) as unknown as typeof fetch;
      expect(await validateGeminiKey('bad', fetchImpl)).toMatch(/abgelehnt/);
    }
  });

  it('does not fail a probably-good key on transient/network trouble', async () => {
    const fetch500 = (() => new Response('err', { status: 500 })) as unknown as typeof fetch;
    expect(await validateGeminiKey('k', fetch500)).toBeNull();
    const fetchThrows = (() => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await validateGeminiKey('k', fetchThrows)).toBeNull();
  });
});

describe('selectCredentialFrom — no silent fallback', () => {
  it('codex needs no stored key', () => {
    expect(selectCredentialFrom('chatgpt-codex', null)).toEqual({ provider: 'chatgpt-codex' });
  });

  it('resolves a configured Anthropic key', () => {
    const row = { encryptedApiKey: encryptApiKey('sk-ant-secret'), preferredModel: 'claude-sonnet-4-6', enabled: true };
    expect(selectCredentialFrom('anthropic-api', row)).toEqual({
      provider: 'anthropic-api',
      apiKey: 'sk-ant-secret',
      modelHint: 'claude-sonnet-4-6',
    });
  });

  it('resolves a configured Gemini key', () => {
    const row = { encryptedApiKey: encryptApiKey('AIza-secret'), preferredModel: 'gemini-2.5-pro', enabled: true };
    expect(selectCredentialFrom('gemini-api', row)).toEqual({
      provider: 'gemini-api',
      apiKey: 'AIza-secret',
      modelHint: 'gemini-2.5-pro',
    });
  });

  it('throws (never falls back) when a key-backed provider has no key', () => {
    expect(() => selectCredentialFrom('anthropic-api', null)).toThrow(AegisProviderKeyMissingError);
    expect(() => selectCredentialFrom('gemini-api', { encryptedApiKey: 'x', preferredModel: null, enabled: false })).toThrow(
      AegisProviderKeyMissingError,
    );
  });

  it('surfaces a friendly error when the stored ciphertext cannot be decrypted', () => {
    const row = { encryptedApiKey: 'v1.bad.bad.bad', preferredModel: null, enabled: true };
    expect(() => selectCredentialFrom('anthropic-api', row)).toThrow(/entschlüsselt/);
  });
});

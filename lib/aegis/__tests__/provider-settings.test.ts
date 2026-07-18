import { describe, expect, it } from 'vitest';
import {
  decryptApiKey,
  encryptApiKey,
  fingerprintApiKey,
  parseProvider,
} from '../provider-settings';

describe('provider-settings BYOK crypto helpers', () => {
  it('round-trips API keys without storing plaintext in the ciphertext', () => {
    const key = 'dummy-anthropic-key-for-test-7890';
    const encrypted = encryptApiKey(key);
    expect(encrypted).not.toContain(key);
    expect(decryptApiKey(encrypted)).toBe(key);
  });

  it('creates stable non-secret fingerprints', () => {
    expect(fingerprintApiKey('abc')).toBe(fingerprintApiKey('abc'));
    expect(fingerprintApiKey('abc')).not.toBe(fingerprintApiKey('def'));
    expect(fingerprintApiKey('abc')).toHaveLength(16);
  });

  it('accepts only supported provider ids', () => {
    expect(parseProvider('ANTHROPIC')).toBe('ANTHROPIC');
    expect(parseProvider('OPENAI')).toBe('OPENAI');
    expect(parseProvider('GOOGLE')).toBe('GOOGLE');
    expect(parseProvider('MISTRAL')).toBeNull();
    expect(parseProvider(null)).toBeNull();
  });
});

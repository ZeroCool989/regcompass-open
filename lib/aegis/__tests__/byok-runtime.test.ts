import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { classifyUpstream, getClient } from '../client';
import { validateAnthropicKey } from '../provider-settings';

function authError(): InstanceType<typeof Anthropic.AuthenticationError> {
  return new Anthropic.AuthenticationError(
    401,
    { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    'invalid x-api-key',
    new Headers(),
  );
}

describe('BYOK runtime behaviour', () => {
  it('maps an auth failure on a USER key to a German, user-actionable error', () => {
    const err = classifyUpstream(authError(), true);
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('Ihr hinterlegter Anthropic API-Schlüssel');
    expect(err.message).toContain('Konto → AI-Provider');
  });

  it('maps an auth failure on the SYSTEM key to internal_error (ops-facing)', () => {
    const err = classifyUpstream(authError(), false);
    expect(err.code).toBe('internal_error');
    expect(err.message).toContain('ANTHROPIC_API_KEY');
  });

  it('returns a distinct client for a BYOK key and reuses it from cache', () => {
    const a = getClient('sk-ant-byok-test-key-000000000001');
    const b = getClient('sk-ant-byok-test-key-000000000001');
    const c = getClient('sk-ant-byok-test-key-000000000002');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('evicts oldest cached BYOK clients beyond the cap instead of growing unboundedly', () => {
    const first = getClient('sk-ant-byok-evict-test-0');
    for (let i = 1; i <= 60; i++) getClient(`sk-ant-byok-evict-test-${i}`);
    // After 60 more keys the first one must have been evicted → new instance.
    expect(getClient('sk-ant-byok-evict-test-0')).not.toBe(first);
  });
});

describe('validateAnthropicKey', () => {
  it('accepts a key when the models endpoint answers 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await validateAnthropicKey('sk-ant-valid', fetchMock as typeof fetch)).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('api.anthropic.com/v1/models');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'sk-ant-valid' });
  });

  it('rejects a key on 401 with a German message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const msg = await validateAnthropicKey('sk-ant-bad', fetchMock as typeof fetch);
    expect(msg).toContain('abgelehnt');
  });

  it('does not block saving on transient upstream/network trouble', async () => {
    const fetch500 = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    expect(await validateAnthropicKey('sk-ant-x', fetch500 as typeof fetch)).toBeNull();
    const fetchDown = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await validateAnthropicKey('sk-ant-x', fetchDown as typeof fetch)).toBeNull();
  });
});

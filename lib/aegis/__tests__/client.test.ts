import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// Mock the SDK so the "reaches the API" test can spy on messages.create without
// a network call. Placement tests don't touch the client (getClient is lazy).
// We spread the REAL module so the error classes (APIConnectionError, …) used by
// `shouldRetry`/`classifyUpstream` via `instanceof` resolve to the genuine
// constructors, and copy the real default's statics onto the mock class so
// `Anthropic.APIConnectionError` (a static on the default export) still works.
const { mockCreate, mockStream } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockStream: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', async (importActual) => {
  const actual = (await importActual()) as typeof import('@anthropic-ai/sdk');
  class MockAnthropic {
    messages = { create: mockCreate, stream: mockStream };
  }
  // The SDK attaches its error classes as (non-enumerable) statics on the
  // default export; copy the ones client.ts references via `instanceof` from the
  // named exports so the mock's default carries real, instance-matching classes.
  Object.assign(MockAnthropic, {
    APIConnectionError: actual.APIConnectionError,
    APIConnectionTimeoutError: actual.APIConnectionTimeoutError,
    AuthenticationError: actual.AuthenticationError,
    BadRequestError: actual.BadRequestError,
    RateLimitError: actual.RateLimitError,
    InternalServerError: actual.InternalServerError,
  });
  return { ...actual, default: MockAnthropic };
});

import AnthropicSDK from '@anthropic-ai/sdk';
import { callClaude, readRetryAfterSeconds, retryDelayMs, shouldRetry, streamClaude, withMessageCacheBreakpoint } from '../client';
import { MODEL_IDS } from '../types';
import { AegisError } from '../types';

const OK_RESPONSE = {
  id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: {
    input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  },
};

function connErr(message = 'ECONNRESET'): Error {
  return new AnthropicSDK.APIConnectionError({ message });
}
function statusErr(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

const EPHEMERAL = { type: 'ephemeral' };

function blocksOf(msg: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  return msg.content as Anthropic.ContentBlockParam[];
}

// ───────────────────────── Placement ─────────────────────────

describe('withMessageCacheBreakpoint — placement', () => {
  it('promotes a string-content last message to a text block carrying cache_control', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Was sind die DORA-Anforderungen?' },
    ];

    const out = withMessageCacheBreakpoint(messages);
    const blocks = blocksOf(out[0]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: 'Was sind die DORA-Anforderungen?',
      cache_control: EPHEMERAL,
    });
  });

  it('marks the LAST block of an array-content last message, leaving earlier blocks alone', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b' },
        ],
      },
    ];

    const out = withMessageCacheBreakpoint(messages);
    const blocks = blocksOf(out[1]);

    expect(blocks[1]).toMatchObject({ tool_use_id: 't2', cache_control: EPHEMERAL });
    expect('cache_control' in blocks[0]).toBe(false); // earlier block untouched
    expect('cache_control' in blocksOf(out[0])[0]).toBe(false); // earlier message untouched
  });

  it('marks only the tail as history grows (rolling breakpoint)', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
    ];

    const out = withMessageCacheBreakpoint(messages);

    expect(typeof out[0].content).toBe('string'); // untouched
    expect('cache_control' in blocksOf(out[1])[0]).toBe(false); // untouched
    expect(blocksOf(out[2])[0]).toMatchObject({ cache_control: EPHEMERAL }); // only the tail
  });

  it('does not mutate the input array or its messages', () => {
    const original: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));

    withMessageCacheBreakpoint(original);

    expect(original).toEqual(snapshot); // input is unchanged (clone returned)
  });

  it('returns the input unchanged when there are no messages', () => {
    expect(withMessageCacheBreakpoint([])).toEqual([]);
  });
});

// ───────────────────────── Reaches the SDK ─────────────────────────

describe('callClaude — applies the rolling breakpoint to the request', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens: 10, output_tokens: 5,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    });
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    mockCreate.mockReset();
  });

  it('passes messages whose last block carries cache_control into messages.create', async () => {
    await callClaude({
      model: MODEL_IDS.sonnet,
      systemBlocks: [{ text: 'system', cached: true }],
      tools: [],
      messages: [
        { role: 'user', content: 'erste Frage' },
        { role: 'assistant', content: [{ type: 'text', text: 'antwort' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
      ],
      maxTokens: 100,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sent = mockCreate.mock.calls[0][0] as Anthropic.MessageCreateParamsNonStreaming;
    const lastMsg = sent.messages[sent.messages.length - 1];
    const blocks = lastMsg.content as Anthropic.ContentBlockParam[];

    expect(blocks[blocks.length - 1]).toMatchObject({ cache_control: EPHEMERAL });
    // Earlier messages stay un-breakpointed (single rolling breakpoint).
    expect(typeof sent.messages[0].content === 'string').toBe(true);
  });
});

// ───────────────────────── Retry policy (3.6) ─────────────────────────

describe('shouldRetry — SDK-superset predicate (no sleeps)', () => {
  it('retries connection resets/timeouts (APIConnectionError + subclass)', () => {
    expect(shouldRetry(connErr())).toBe(true);
    expect(shouldRetry(new AnthropicSDK.APIConnectionTimeoutError({ message: 't' }))).toBe(true);
  });

  it('retries 408, 409, 429 and EVERY status >= 500 — including 529 overloaded (ARCH-01)', () => {
    for (const code of [408, 409, 429, 500, 502, 503, 504, 529, 599]) {
      expect(shouldRetry(statusErr(code)), `status ${code}`).toBe(true);
    }
  });

  it('does not retry 400/401/403/404/422 or non-error values', () => {
    for (const code of [400, 401, 403, 404, 422]) {
      expect(shouldRetry(statusErr(code)), `status ${code}`).toBe(false);
    }
    expect(shouldRetry(null)).toBe(false);
    expect(shouldRetry('boom')).toBe(false);
    expect(shouldRetry(new Error('plain'))).toBe(false);
  });
});

describe('retryDelayMs — exponential backoff with jitter, Retry-After precedence', () => {
  it('grows the ceiling exponentially and jitters within it', () => {
    expect(retryDelayMs(1, undefined, 8000, () => 1)).toBe(1000);
    expect(retryDelayMs(2, undefined, 8000, () => 1)).toBe(2000);
    expect(retryDelayMs(4, undefined, 8000, () => 1)).toBe(8000); // capped
    expect(retryDelayMs(1, undefined, 8000, () => 0)).toBe(0); // full jitter floor
  });

  it('honors Retry-After seconds, capped against hostile values', () => {
    expect(retryDelayMs(1, 3)).toBe(3000);
    expect(retryDelayMs(1, 9999)).toBe(8000);
  });

  it('reads Retry-After from SDK error headers', () => {
    expect(readRetryAfterSeconds({ headers: { 'retry-after': '2' } })).toBe(2);
    expect(readRetryAfterSeconds({ headers: new Headers({ 'Retry-After': '5' }) })).toBe(5);
    expect(readRetryAfterSeconds({ headers: { 'retry-after': 'nonsense' } })).toBeUndefined();
    expect(readRetryAfterSeconds(statusErr(500))).toBeUndefined();
  });
});

describe('callClaude — retry policy', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const call = () =>
    callClaude({
      model: MODEL_IDS.sonnet,
      systemBlocks: [{ text: 'system', cached: true }],
      tools: [],
      messages: [{ role: 'user', content: 'frage' }],
      maxTokens: 100,
    });

  it('retries a 429 and succeeds within 3 attempts', async () => {
    mockCreate
      .mockRejectedValueOnce(statusErr(429))
      .mockResolvedValueOnce(OK_RESPONSE);
    await call();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries a connection reset (APIConnectionError) — the case maxRetries:0 would drop', async () => {
    mockCreate
      .mockRejectedValueOnce(connErr())
      .mockResolvedValueOnce(OK_RESPONSE);
    await call();
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 — throws after one attempt', async () => {
    mockCreate.mockRejectedValue(statusErr(400));
    await expect(call()).rejects.toBeInstanceOf(AegisError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts on persistent 503', async () => {
    mockCreate.mockRejectedValue(statusErr(503));
    await expect(call()).rejects.toBeInstanceOf(AegisError);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('forwards tool_choice into the request when provided (3.1)', async () => {
    mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    await callClaude({
      model: MODEL_IDS.sonnet,
      systemBlocks: [{ text: 'system', cached: true }],
      tools: [],
      messages: [{ role: 'user', content: 'frage' }],
      maxTokens: 100,
      toolChoice: { type: 'none' },
    });
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.tool_choice).toEqual({ type: 'none' });
  });

  it('omits tool_choice when not provided', async () => {
    mockCreate.mockResolvedValueOnce(OK_RESPONSE);
    await callClaude({
      model: MODEL_IDS.sonnet,
      systemBlocks: [{ text: 'system', cached: true }],
      tools: [],
      messages: [{ role: 'user', content: 'frage' }],
      maxTokens: 100,
    });
    expect('tool_choice' in mockCreate.mock.calls[0][0]).toBe(false);
  });

  it('replays a byte-identical request object across retries (stable cache prefix)', async () => {
    mockCreate
      .mockRejectedValueOnce(statusErr(429))
      .mockRejectedValueOnce(statusErr(429))
      .mockResolvedValueOnce(OK_RESPONSE);
    await call();
    expect(mockCreate).toHaveBeenCalledTimes(3);
    const first = mockCreate.mock.calls[0][0];
    expect(mockCreate.mock.calls[1][0]).toBe(first); // same reference
    expect(mockCreate.mock.calls[2][0]).toBe(first);
  });
});

// ───────────────────────── Stream connect-retry (3.6) ─────────────────────────

describe('streamClaude — one-shot connect retry before first byte', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  beforeEach(() => {
    mockStream.mockReset();
  });

  const streamStub = (emitted: () => Promise<void>) => ({ emitted: vi.fn(emitted) });

  const open = () =>
    streamClaude({
      model: MODEL_IDS.sonnet,
      systemBlocks: [{ text: 'system', cached: true }],
      tools: [],
      messages: [{ role: 'user', content: 'frage' }],
      maxTokens: 100,
    });

  it('returns the stream when the connection succeeds (no retry)', async () => {
    const stub = streamStub(() => Promise.resolve());
    mockStream.mockReturnValueOnce(stub);
    const result = await open();
    expect(result).toBe(stub);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('reconnects once when the first connect fails with a retryable error', async () => {
    const bad = streamStub(() => Promise.reject(connErr()));
    const good = streamStub(() => Promise.resolve());
    mockStream.mockReturnValueOnce(bad).mockReturnValueOnce(good);
    const result = await open();
    expect(result).toBe(good);
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable connect failure (400)', async () => {
    const bad = streamStub(() => Promise.reject(statusErr(400)));
    mockStream.mockReturnValueOnce(bad);
    await expect(open()).rejects.toBeInstanceOf(AegisError);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('throws if the single reconnect also fails', async () => {
    const bad1 = streamStub(() => Promise.reject(connErr()));
    const bad2 = streamStub(() => Promise.reject(connErr()));
    mockStream.mockReturnValueOnce(bad1).mockReturnValueOnce(bad2);
    await expect(open()).rejects.toBeInstanceOf(AegisError);
    expect(mockStream).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above all top-level `const` declarations, so the mock
// factory cannot close over local variables. `vi.hoisted` lifts the fn ref
// alongside the mock, keeping both accessible inside the tests.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: {
    aegisUsageLog: {
      create: createMock,
    },
  },
}));

import { logUsage, type AegisUsageRecord } from '../usage-logger';

const SAMPLE: AegisUsageRecord = {
  traceId: 'trace-1',
  conversationId: 'conv-1',
  mode: 'CONVERSATIONAL',
  model: 'claude-haiku-4-5-20251001',
  servedModel: 'claude-haiku-4-5-20251001',
  language: 'de',
  inputTokens: 1500,
  outputTokens: 400,
  cachedTokens: 1000,
  cacheCreationTokens: 500,
  costCents: 0.42,
  pricingVersion: '2026-06-02',
  exitReason: 'done',
  latencyMs: 1234,
  iterations: 2,
  toolCalls: 3,
  verifyPassed: true,
  citationCount: 4,
  guardrailsTriggered: [],
  kbVersion: '2026-05-25',
};

describe('logUsage', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the record to the database', async () => {
    createMock.mockResolvedValueOnce({ id: 'cuid-1', ...SAMPLE });
    await logUsage(SAMPLE);
    expect(createMock).toHaveBeenCalledTimes(1);
    // guardrailsTriggered is stored as a JSON-encoded string (SQLite has no scalar lists).
    expect(createMock).toHaveBeenCalledWith({ data: { ...SAMPLE, guardrailsTriggered: '[]' } });
  });

  it('swallows DB errors, never throws, and reports them observably', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createMock.mockRejectedValueOnce(new Error('boom'));
    await expect(logUsage(SAMPLE)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();

    // Structured, queryable telemetry — the hook for a log-based alert.
    const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      event: 'aegis_usage_log_failed',
      level: 'error',
      model: SAMPLE.model,
      exitReason: SAMPLE.exitReason,
    });
    expect(payload.detail).toContain('boom');
  });

  it('rejects an invalid record without hitting the DB, and reports it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Negative token count fails the Zod schema.
    const bad = { ...SAMPLE, inputTokens: -1 };

    await expect(logUsage(bad)).resolves.toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();

    const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      event: 'aegis_usage_log_rejected',
      level: 'error',
      model: SAMPLE.model,
    });
  });
});

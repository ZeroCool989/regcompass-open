import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { exitReasonSplit } from '@/lib/aegis/usage-stats';

// Mock the DB so the route runs without Postgres.
const { aggregate, count, groupBy, findMany, queryRaw } = vi.hoisted(() => ({
  aggregate: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    aegisUsageLog: { aggregate, count, groupBy, findMany },
    $queryRaw: queryRaw,
  },
}));

// Usage is admin-only; mock the auth gate (default: an APPROVED admin).
const { getUserFromRequest } = vi.hoisted(() => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getUserFromRequest }));

import { GET } from '../route';

function req(): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest;
}

describe('GET /api/aegis/usage', () => {
  beforeEach(() => {
    aggregate.mockReset();
    count.mockReset();
    groupBy.mockReset();
    findMany.mockReset();
    queryRaw.mockReset();
    getUserFromRequest.mockReset();
    getUserFromRequest.mockResolvedValue({ role: 'ADMIN', status: 'APPROVED' });

    // Promise.all order: agg(all) → agg(comparable) → count → groupBy×5 → findMany(window) → findMany(recent)
    aggregate
      .mockResolvedValueOnce({
        _count: { _all: 10 },
        _sum: { inputTokens: 1000, outputTokens: 500, cachedTokens: 200, costCents: 1000 },
        _avg: { latencyMs: 1200 },
      }) // ALL rows
      .mockResolvedValueOnce({
        _count: { _all: 7 },
        _sum: { costCents: 700 },
      }); // NON-LEGACY (comparable)
    count.mockResolvedValue(8); // verifyPassed count
    groupBy
      .mockResolvedValueOnce([]) // byModel
      .mockResolvedValueOnce([]) // byMode
      .mockResolvedValueOnce([]) // byModeVerify
      .mockResolvedValueOnce([
        { exitReason: 'done', _count: { _all: 5 }, _sum: { costCents: 600 } },
        { exitReason: 'cost_limit', _count: { _all: 2 }, _sum: { costCents: 100 } },
      ]) // byExitReason (non-legacy)
      .mockResolvedValueOnce([
        { servedModel: 'claude-sonnet-4-6', _count: { _all: 7 }, _sum: { costCents: 700 } },
        { servedModel: null, _count: { _all: 3 }, _sum: { costCents: 300 } },
      ]); // byServedModel
    // Window rows drive the JS-side per-day and guardrail-occurrence aggregation.
    // 7 non-legacy (700) + 3 legacy (300) = 1000, all on one day; guardrail
    // tokens: compress ×3, kill:cost_limit ×1. guardrailsTriggered is a JSON string.
    const day = new Date('2026-06-01T12:00:00Z');
    const windowRows = [
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '["compress"]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '["compress"]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '["compress"]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '["kill:cost_limit"]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '[]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '[]' },
      { createdAt: day, costCents: 100, pricingVersion: 'v2', latencyMs: 1200, guardrailsTriggered: '[]' },
      { createdAt: day, costCents: 100, pricingVersion: 'legacy', latencyMs: 1200, guardrailsTriggered: '[]' },
      { createdAt: day, costCents: 100, pricingVersion: 'legacy', latencyMs: 1200, guardrailsTriggered: '[]' },
      { createdAt: day, costCents: 100, pricingVersion: 'legacy', latencyMs: 1200, guardrailsTriggered: '[]' },
    ];
    findMany.mockResolvedValueOnce(windowRows).mockResolvedValueOnce([]);
  });

  it('excludes legacy-priced rows from the console-comparable total', async () => {
    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.totalCostCents).toBe(1000);     // all rows
    expect(body.summary.comparableCostCents).toBe(700); // non-legacy only
    expect(body.summary.legacyCostCents).toBe(300);     // 1000 − 700
    expect(body.summary.legacyRequests).toBe(3);        // 10 − 7
    // The non-legacy filter reached the comparable aggregate.
    expect(aggregate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ pricingVersion: { not: 'legacy' } }) }),
    );
    // Per-day comparable is surfaced too.
    expect(body.byDay[0].comparableCostCents).toBe(700);
  });

  it('returns byExitReason that yields the done-vs-non-done split', async () => {
    const res = await GET(req());
    const body = await res.json();

    expect(body.byExitReason).toEqual([
      { exitReason: 'done', requests: 5, costCents: 600 },
      { exitReason: 'cost_limit', requests: 2, costCents: 100 },
    ]);

    const split = exitReasonSplit(body.byExitReason);
    expect(split.doneCostCents).toBe(600);
    expect(split.nonDoneCostCents).toBe(100);
    expect(split.donePct).toBeCloseTo((600 / 700) * 100, 4);
  });

  it('exposes guardrail occurrences and maps a null servedModel to "unknown"', async () => {
    const res = await GET(req());
    const body = await res.json();

    expect(body.byGuardrail).toEqual([
      { token: 'compress', count: 3 },
      { token: 'kill:cost_limit', count: 1 },
    ]);
    expect(body.byServedModel.map((s: { servedModel: string }) => s.servedModel)).toContain('unknown');
  });

  it('rejects a non-admin caller with 403 (telemetry is admin-only)', async () => {
    getUserFromRequest.mockResolvedValue({ role: 'USER', status: 'APPROVED' });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 403', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});

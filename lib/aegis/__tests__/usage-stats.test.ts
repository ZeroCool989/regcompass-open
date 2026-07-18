import { describe, expect, it } from 'vitest';
import { exitReasonSplit, type ExitReasonRow } from '../usage-stats';

describe('exitReasonSplit', () => {
  it('splits done vs non-done spend and computes the done share', () => {
    const rows: ExitReasonRow[] = [
      { exitReason: 'done', requests: 5, costCents: 600 },
      { exitReason: 'cost_limit', requests: 2, costCents: 100 },
      { exitReason: 'aborted', requests: 1, costCents: 50 },
    ];

    const s = exitReasonSplit(rows);

    expect(s.doneCostCents).toBe(600);
    expect(s.doneRequests).toBe(5);
    expect(s.nonDoneCostCents).toBe(150); // cost_limit + aborted
    expect(s.nonDoneRequests).toBe(3);
    expect(s.donePct).toBeCloseTo((600 / 750) * 100, 4);
  });

  it('treats every non-`done` reason (incl. legacy "unknown") as non-done', () => {
    const s = exitReasonSplit([
      { exitReason: 'unknown', requests: 4, costCents: 400 },
      { exitReason: 'done', requests: 1, costCents: 100 },
    ]);
    expect(s.nonDoneCostCents).toBe(400);
    expect(s.donePct).toBeCloseTo(20, 4);
  });

  it('returns zeros and 0% on empty input (no divide-by-zero)', () => {
    const s = exitReasonSplit([]);
    expect(s).toEqual({
      doneRequests: 0,
      doneCostCents: 0,
      nonDoneRequests: 0,
      nonDoneCostCents: 0,
      donePct: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  AGING_DAYS,
  computeMemoryHealth,
  contradicts,
  deriveStage,
  detectContradictions,
  findConflict,
  findDuplicates,
  similarity,
  type GovEntry,
} from '@/lib/aegis/soul-health';

const NOW = Date.UTC(2026, 5, 17);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function entry(p: Partial<GovEntry> & { id: string; content: string }): GovEntry {
  return {
    section: 'communication_style',
    signalCount: 1,
    status: 'ACTIVE',
    usedCount: 0,
    lastConfirmedAt: daysAgo(1),
    ...p,
  };
}

describe('lifecycle stage', () => {
  it('active when recently confirmed, aging past the threshold, archived by status', () => {
    expect(deriveStage(entry({ id: '1', content: 'x', lastConfirmedAt: daysAgo(5) }), NOW)).toBe('active');
    expect(deriveStage(entry({ id: '2', content: 'x', lastConfirmedAt: daysAgo(AGING_DAYS + 10) }), NOW)).toBe('aging');
    expect(deriveStage(entry({ id: '3', content: 'x', status: 'ARCHIVED' }), NOW)).toBe('archived');
  });
});

describe('duplicates', () => {
  it('flags near-identical entries and not distinct ones', () => {
    expect(similarity('Antworten bitte knapp halten', 'Antworten bitte knapp halten')).toBe(1);
    const dups = findDuplicates([
      entry({ id: 'a', content: 'Antworten bitte knapp und prägnant halten' }),
      entry({ id: 'b', content: 'Antworten bitte knapp und prägnant halten' }),
      entry({ id: 'c', content: 'Tabellen gegenüber Fliesstext bevorzugen' }),
    ]);
    expect(dups.map((d) => [d.a, d.b].sort())).toContainEqual(['a', 'b']);
    expect(dups.some((d) => d.a === 'c' || d.b === 'c')).toBe(false);
  });
});

describe('contradictions', () => {
  it('detects opposite poles on a section axis', () => {
    expect(contradicts('Bitte knappe Antworten.', 'Bitte ausführliche Antworten.')).not.toBeNull();
    expect(contradicts('Zuerst die Umsetzung.', 'Zuerst die Theorie.')).not.toBeNull();
  });
  it('does not flag unrelated preferences', () => {
    expect(contradicts('Bitte knappe Antworten.', 'Tabellen bevorzugt.')).toBeNull();
  });
  it('findConflict returns the conflicting active entry + axis', () => {
    const active = [entry({ id: 'old', content: 'Bevorzugt knappe Antworten.' })];
    const conflict = findConflict('Bevorzugt ausführliche Erklärungen.', 'communication_style', active);
    expect(conflict?.entry.id).toBe('old');
    expect(conflict?.axis).toBe('Länge');
  });
  it('only contradicts within the same section', () => {
    const pairs = detectContradictions([
      entry({ id: 'a', section: 'communication_style', content: 'knapp' }),
      entry({ id: 'b', section: 'output_formats', content: 'ausführlich' }),
    ]);
    expect(pairs).toEqual([]);
  });
});

describe('memory health', () => {
  it('is 100 for an empty soul', () => {
    expect(computeMemoryHealth([]).score).toBe(100);
  });

  it('a clean, fresh, corroborated set scores high', () => {
    const h = computeMemoryHealth(
      [
        entry({ id: 'a', content: 'Bevorzugt knappe Antworten.', signalCount: 5, usedCount: 8, lastConfirmedAt: daysAgo(2) }),
        entry({ id: 'b', section: 'output_formats', content: 'Tabellen bevorzugt.', signalCount: 4, usedCount: 6, lastConfirmedAt: daysAgo(3) }),
      ],
      NOW,
    );
    expect(h.score).toBeGreaterThanOrEqual(85);
    expect(h.band).toBe('excellent');
    expect(h.contradictionCount).toBe(0);
  });

  it('contradictions lower consistency and the score', () => {
    const clean = computeMemoryHealth([entry({ id: 'a', content: 'Bevorzugt knappe Antworten.' })], NOW);
    const conflicted = computeMemoryHealth(
      [
        entry({ id: 'a', content: 'Bevorzugt knappe Antworten.' }),
        entry({ id: 'b', content: 'Bevorzugt ausführliche Antworten.' }),
      ],
      NOW,
    );
    expect(conflicted.contradictionCount).toBeGreaterThan(0);
    expect(conflicted.factors.consistency).toBeLessThan(clean.factors.consistency);
    expect(conflicted.score).toBeLessThan(clean.score);
  });

  it('stale entries reduce freshness and count as aging', () => {
    const h = computeMemoryHealth(
      [entry({ id: 'a', content: 'Bevorzugt knappe Antworten.', lastConfirmedAt: daysAgo(200) })],
      NOW,
    );
    expect(h.factors.freshness).toBeLessThan(1);
    expect(h.agingCount).toBe(1);
  });

  it('duplicates reduce the score', () => {
    const h = computeMemoryHealth(
      [
        entry({ id: 'a', content: 'Antworten knapp und prägnant halten bitte' }),
        entry({ id: 'b', content: 'Antworten knapp und prägnant halten bitte' }),
      ],
      NOW,
    );
    expect(h.duplicateCount).toBeGreaterThan(0);
    expect(h.factors.duplicates).toBeGreaterThan(0);
  });
});

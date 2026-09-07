import { describe, expect, it } from 'vitest';
import {
  contradicts,
  findConflict,
  findDuplicates,
  similarity,
  type GovEntry,
} from '@/lib/aegis/soul-health';

function entry(p: Partial<GovEntry> & { id: string; content: string }): GovEntry {
  return {
    section: 'communication_style',
    status: 'ACTIVE',
    ...p,
  };
}

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
});

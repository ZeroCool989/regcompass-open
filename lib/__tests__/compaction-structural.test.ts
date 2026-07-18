import { describe, expect, it } from 'vitest';
import { applyDigestToSeed, type ConversationDigest } from '@/lib/aegis/digest';
import { buildSeed, type SeedMessage, type SeedSourceMessage } from '@/lib/aegis/memory-seed';

/**
 * Tier-A structural compaction tests (deterministic, no model). They prove the
 * invariants the review called out: seed integrity after a digest is applied,
 * that only post-digest turns are replayed, and that repeated compaction cycles
 * stay valid with a monotonic throughSeq. (Fidelity-of-content lives in the
 * opt-in Tier-B eval against a real model.)
 */

const DIGEST: ConversationDigest = {
  decisions: ['Nutzer wählt EU AI Act'],
  openTasks: ['DSFA offen'],
  conclusions: ['Hochrisiko gemäss [R-EUAIA-0006]'],
  preferencesObserved: [],
};

const BIG_BUDGET = 1_000_000;

/** Build N complete user/assistant pairs as transcript rows (seq 0..2N-1). */
function transcript(pairs: number): SeedSourceMessage[] {
  const rows: SeedSourceMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    rows.push({ seq: i * 2, role: 'user', content: `Frage ${i}`, status: 'complete' });
    rows.push({ seq: i * 2 + 1, role: 'assistant', content: `Antwort ${i}`, status: 'complete' });
  }
  return rows;
}

/** Mirror of index.ts seed assembly: digest pair + replay of seq > throughSeq. */
function assembleSeed(
  rows: SeedSourceMessage[],
  digest: ConversationDigest | null,
  throughSeq: number | null,
): SeedMessage[] {
  const seedRows = digest && throughSeq != null ? rows.filter((r) => r.seq > throughSeq) : rows;
  const built = buildSeed(seedRows, 'de', BIG_BUDGET);
  return digest && throughSeq != null ? applyDigestToSeed(digest, built) : built;
}

function isValidSeed(seed: SeedMessage[]): boolean {
  if (seed.length === 0) return true;
  if (seed[0].role !== 'user') return false;
  return seed.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant'));
}

describe('seed integrity with a digest', () => {
  it('starts with user and strictly alternates', () => {
    const rows = transcript(10);
    const seed = assembleSeed(rows, DIGEST, 9); // compact through seq 9 (first 5 pairs)
    expect(isValidSeed(seed)).toBe(true);
  });

  it('replays only turns after throughSeq, prefixed by the digest pair', () => {
    const rows = transcript(10); // seqs 0..19
    const throughSeq = 9;
    const seed = assembleSeed(rows, DIGEST, throughSeq);
    // First pair is the synthetic digest.
    expect(seed[0].role).toBe('user');
    expect(seed[1].content).toContain('[R-EUAIA-0006]');
    // No pre-digest content leaks in.
    const body = seed.slice(2).map((m) => m.content).join(' ');
    expect(body).toContain('Frage 5'); // pair index 5 → seqs 10/11 (> 9)
    expect(body).not.toContain('Frage 4'); // seqs 8/9 (<= 9) are compacted away
  });

  it('is byte-identical to the no-digest path when no digest exists', () => {
    const rows = transcript(4);
    const withoutDigest = assembleSeed(rows, null, null);
    const plain = buildSeed(rows, 'de', BIG_BUDGET);
    expect(withoutDigest).toEqual(plain);
  });
});

describe('repeated compaction stability', () => {
  it('throughSeq is monotonic and the seed stays valid across cycles', () => {
    let rows = transcript(5); // 10 rows
    let throughSeq = -1;
    const seen: number[] = [];

    for (let cycle = 0; cycle < 10; cycle++) {
      // A compaction always covers the full current transcript.
      const newThrough = Math.max(...rows.map((r) => r.seq));
      expect(newThrough).toBeGreaterThan(throughSeq); // monotonic
      throughSeq = newThrough;
      seen.push(throughSeq);

      const seed = assembleSeed(rows, DIGEST, throughSeq);
      expect(isValidSeed(seed)).toBe(true);
      // After compacting the whole transcript, only the digest pair remains.
      expect(seed).toHaveLength(2);

      // Simulate two more turns before the next cycle.
      const base = rows.length;
      rows = [
        ...rows,
        { seq: base, role: 'user', content: `Frage neu ${cycle}`, status: 'complete' },
        { seq: base + 1, role: 'assistant', content: `Antwort neu ${cycle}`, status: 'complete' },
      ];
    }

    // Strictly increasing.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });
});

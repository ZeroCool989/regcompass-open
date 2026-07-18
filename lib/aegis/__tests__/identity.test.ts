import { describe, expect, it } from 'vitest';
import { KB } from '@/lib/kb';
import { AEGIS_SYSTEM_PROMPT, buildKbTableOfContents } from '../prompts/identity';

describe('KB table-of-contents (3.7)', () => {
  it('is deterministic across calls (byte-identical for a stable cache prefix)', () => {
    expect(buildKbTableOfContents()).toBe(buildKbTableOfContents());
  });

  it('is sorted by regulation id ascending', () => {
    const sortedIds = [...KB.regulations.map((r) => r.id)].sort();
    const toc = buildKbTableOfContents().split('\n');
    // Each line names a regulation by shortName in id-sorted order.
    const shortNamesInIdOrder = sortedIds.map(
      (id) => KB.regulations.find((r) => r.id === id)!.shortName,
    );
    shortNamesInIdOrder.forEach((shortName, i) => {
      expect(toc[i].startsWith(`- ${shortName} (`)).toBe(true);
    });
  });

  it('lists every regulation exactly once', () => {
    const toc = buildKbTableOfContents().split('\n');
    expect(toc).toHaveLength(KB.regulations.length);
  });

  it('requirement counts sum to the KB total', () => {
    const counts = buildKbTableOfContents()
      .split('\n')
      .map((l) => Number(l.match(/—\s*(\d+) requirements/)?.[1] ?? 0));
    const sum = counts.reduce((a, b) => a + b, 0);
    expect(sum).toBe(KB.requirements.length);
  });

  it('is embedded in the cached identity prompt', () => {
    expect(AEGIS_SYSTEM_PROMPT).toContain('KNOWLEDGE BASE MAP');
    expect(AEGIS_SYSTEM_PROMPT).toContain(buildKbTableOfContents());
  });
});

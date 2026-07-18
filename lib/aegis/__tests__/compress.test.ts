import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { compressContext } from '../context/compress';
import { MemoryConfig } from '../memory-config';

// Compaction is independent of WHAT triggers it (token budget in F) — this guards
// the behaviour that survives the trigger change: requirement IDs in the retained
// head/tail anchors are kept verbatim even when the middle summary omits them.
describe('compressContext — R-ID preservation', () => {
  it('keeps R-IDs in the retained tail even if the summary drops them', async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Frage über DORA' },                       // head[0]
      { role: 'assistant', content: 'Antwort 1' },                         // head[1]
      { role: 'user', content: 'mitte 1' },                                // middle → summarized
      { role: 'assistant', content: 'mitte 2' },                           // middle
      { role: 'user', content: 'mitte 3' },                                // middle
      { role: 'assistant', content: 'Die Anforderung [R-AIACT-005] gilt.' }, // tail (kept)
      { role: 'user', content: 'und [R-GDPR-006]?' },                      // tail (kept)
      { role: 'assistant', content: 'Ja, [R-GDPR-006] ist relevant.' },    // tail (kept)
      { role: 'user', content: 'letzte Frage' },                           // tail (kept)
    ];
    // Summary deliberately omits the IDs — they must survive via the kept tail.
    const callHaiku = vi.fn().mockResolvedValue({ text: 'Zusammenfassung des mittleren Teils.' });

    const out = await compressContext(messages, 4, callHaiku);
    const blob = JSON.stringify(out);

    expect(callHaiku).toHaveBeenCalled();   // the middle was summarized
    expect(out.length).toBeLessThan(messages.length); // it actually compacted
    expect(blob).toContain('R-AIACT-005');
    expect(blob).toContain('R-GDPR-006');
  });

  it('keeps the configured first/last anchors verbatim and summarizes only the middle', async () => {
    const keepFirst = MemoryConfig.compactionKeepFirst;
    const keepLast = MemoryConfig.compactionKeepLast;
    // first anchors + a middle that must be summarized + last anchors.
    const head = Array.from({ length: keepFirst }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `HEAD-${i}`,
    }));
    const middle = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `MIDDLE-${i}`,
    }));
    const tail = Array.from({ length: keepLast }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `TAIL-${i}`,
    }));
    const messages: Anthropic.MessageParam[] = [...head, ...middle, ...tail];
    const callHaiku = vi.fn().mockResolvedValue({ text: 'Verdichtete Zusammenfassung der Mitte.' });

    const out = await compressContext(messages, keepLast, callHaiku);
    const text = JSON.stringify(out);

    // Anchors survive verbatim…
    for (let i = 0; i < keepFirst; i++) expect(text).toContain(`HEAD-${i}`);
    for (let i = 0; i < keepLast; i++) expect(text).toContain(`TAIL-${i}`);
    // …the middle is replaced by the compressed-history marker, not kept verbatim.
    expect(text).toContain('<<COMPRESSED HISTORY>>');
    expect(text).not.toContain('MIDDLE-2');
  });
});

// Regression: compaction must never orphan a tool_use/tool_result pair across
// the head/middle or middle/tail boundary (Anthropic 400). See tool-pairing.ts.
function assertPairingInvariant(msgs: Anthropic.MessageParam[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const useIds = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
      if (useIds.length > 0) {
        const next = msgs[i + 1];
        expect(next?.role).toBe('user');
        const resIds = (next && Array.isArray(next.content) ? next.content : [])
          .filter((b) => b.type === 'tool_result')
          .map((b) => (b as { tool_use_id: string }).tool_use_id);
        for (const id of useIds) expect(resIds).toContain(id);
      }
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const prev = msgs[i - 1];
          const useIds = (prev && Array.isArray(prev.content) ? prev.content : [])
            .filter((x) => x.type === 'tool_use')
            .map((x) => (x as { id: string }).id);
          expect(useIds).toContain(b.tool_use_id);
        }
      }
    }
  }
}

const toolUseMsg = (...ids: string[]): Anthropic.MessageParam => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use', id, name: 'search_kb', input: {} })),
});
const toolResultMsg = (...ids: string[]): Anthropic.MessageParam => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'Treffer: R-AIACT-005' })),
});

describe('compressContext — tool_use/tool_result boundary safety', () => {
  it('does not orphan the head tool_use turn (head/middle boundary)', async () => {
    // head = [user, assistant(tool_use t1,t2)]; the matching results sit at idx 2
    // (in the middle) — the bug summarized them away, orphaning the tool_use.
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Frage über DORA' },
      toolUseMsg('t1', 't2'),
      toolResultMsg('t1', 't2'),
      { role: 'assistant', content: 'Zwischenantwort' },
      { role: 'user', content: 'weiter' },
      { role: 'assistant', content: 'mehr' },
      { role: 'user', content: 'tail-frage' },
      { role: 'assistant', content: 'Antwort [R-AIACT-005]' },
      { role: 'user', content: 'letzte' },
    ];
    const callHaiku = vi.fn().mockResolvedValue({ text: 'Zusammenfassung des mittleren Teils.' });
    const out = await compressContext(messages, 4, callHaiku);
    assertPairingInvariant(out);
    expect(out.length).toBeLessThan(messages.length); // still compacted
  });

  it('does not orphan a tool_result-leading tail (middle/tail boundary)', async () => {
    // Build so messages.length - keepLast lands on a tool_result user message
    // whose tool_use is in the middle.
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Frage' },
      { role: 'assistant', content: 'Antwort 1' },
      { role: 'user', content: 'mitte 1' },
      { role: 'assistant', content: 'mitte 2' },
      toolUseMsg('tA'), // owns the tail-leading tool_result
      toolResultMsg('tA'), // lands at the keepLast boundary
      { role: 'assistant', content: 'Antwort 2 [R-AIACT-005]' },
      { role: 'user', content: 'frage 3' },
      { role: 'assistant', content: 'Antwort 3' },
      { role: 'user', content: 'letzte' },
    ];
    const callHaiku = vi.fn().mockResolvedValue({ text: 'Zusammenfassung des mittleren Teils.' });
    const out = await compressContext(messages, 4, callHaiku);
    assertPairingInvariant(out);
  });

  it('no-ops when snapping collapses the middle (nothing safe to compress)', async () => {
    // anchor=2 + keepLast=4 = 6; length 7. The single middle message is a
    // tool_result whose tool_use is in head → snapping leaves nothing to summarize.
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Frage' },
      toolUseMsg('t1'),
      toolResultMsg('t1'),
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'letzte' },
    ];
    const callHaiku = vi.fn().mockResolvedValue({ text: 'sollte nicht aufgerufen werden' });
    const out = await compressContext(messages, 4, callHaiku);
    expect(out).toEqual(messages); // unchanged
    expect(callHaiku).not.toHaveBeenCalled();
    assertPairingInvariant(out);
  });
});

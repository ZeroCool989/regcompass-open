import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  hasToolUse,
  repairToolPairing,
  safeHeadEnd,
  safeTailStart,
} from '../context/tool-pairing';

// ───────────────────────── Fixtures ─────────────────────────

function user(text: string): Anthropic.MessageParam {
  return { role: 'user', content: text };
}
function toolUseMsg(...ids: string[]): Anthropic.MessageParam {
  return {
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool_use', id, name: 'search_kb', input: {} })),
  };
}
function toolResultMsg(...ids: string[]): Anthropic.MessageParam {
  return {
    role: 'user',
    content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
  };
}

/**
 * Asserts the Anthropic pairing invariant over a message array: every assistant
 * tool_use is immediately followed by a user tool_result for each id; every
 * tool_result has a matching tool_use in the immediately preceding message.
 * Exported-by-copy in compress.test.ts too (kept local to avoid cross-test imports).
 */
export function assertPairingInvariant(msgs: Anthropic.MessageParam[]): void {
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

// ───────────────────────── repairToolPairing ─────────────────────────

describe('repairToolPairing', () => {
  it('keeps a valid parallel pair untouched', () => {
    const msgs = [user('frage'), toolUseMsg('t1', 't2'), toolResultMsg('t1', 't2')];
    expect(repairToolPairing(msgs)).toEqual(msgs);
  });

  it('drops a tool_use-only turn with no following results', () => {
    const msgs = [user('frage'), toolUseMsg('t1', 't2')]; // results were summarized away
    const out = repairToolPairing(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(user('frage'));
    assertPairingInvariant(out);
  });

  it('drops an orphaned tool_result-only user turn', () => {
    const msgs = [user('<<COMPRESSED>>'), toolResultMsg('t1')]; // tool_use is gone
    const out = repairToolPairing(msgs);
    expect(out).toHaveLength(1);
    assertPairingInvariant(out);
  });

  it('keeps text but drops the unpaired tool_use on a mixed text+tool_use turn', () => {
    const mixed: Anthropic.MessageParam = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Ich schaue nach.' },
        { type: 'tool_use', id: 't1', name: 'search_kb', input: {} },
      ],
    };
    const out = repairToolPairing([user('frage'), mixed]); // no results follow
    expect(out).toHaveLength(2);
    const kept = out[1].content as Anthropic.ContentBlockParam[];
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('text');
    assertPairingInvariant(out);
  });

  it('is idempotent', () => {
    const msgs = [user('a'), toolUseMsg('t1'), user('<<COMPRESSED>>'), toolResultMsg('t9')];
    const once = repairToolPairing(msgs);
    expect(repairToolPairing(once)).toEqual(once);
  });

  it('leaves string-content messages untouched', () => {
    const msgs = [user('a'), { role: 'assistant', content: 'plain answer' } as Anthropic.MessageParam];
    expect(repairToolPairing(msgs)).toEqual(msgs);
  });
});

// ───────────────────────── boundary snapping ─────────────────────────

describe('safeHeadEnd / safeTailStart / hasToolUse', () => {
  it('hasToolUse detects assistant tool_use turns only', () => {
    expect(hasToolUse(toolUseMsg('t1'))).toBe(true);
    expect(hasToolUse(user('x'))).toBe(false);
    expect(hasToolUse(toolResultMsg('t1'))).toBe(false);
  });

  it('safeHeadEnd extends the head past a tool_use turn to include its results', () => {
    // [user, assistant(tool_use), user(tool_result), ...] — anchor 2 would cut
    // between the tool_use (idx 1) and its results (idx 2); snap forward to 3.
    const msgs = [user('frage'), toolUseMsg('t1'), toolResultMsg('t1'), user('mehr')];
    expect(safeHeadEnd(msgs, 2)).toBe(3);
  });

  it('safeHeadEnd is a no-op when the boundary is not on a tool_use turn', () => {
    const msgs = [user('frage'), { role: 'assistant', content: 'antwort' } as Anthropic.MessageParam, user('mehr')];
    expect(safeHeadEnd(msgs, 2)).toBe(2);
  });

  it('safeTailStart pulls the owning assistant turn into a tool_result-leading tail', () => {
    // tail would start at idx 2 (tool_result) whose tool_use is at idx 1 → snap back to 1.
    const msgs = [user('frage'), toolUseMsg('t1'), toolResultMsg('t1'), user('letzte')];
    expect(safeTailStart(msgs, 2)).toBe(1);
  });
});

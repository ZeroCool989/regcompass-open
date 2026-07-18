import { describe, it, expect, afterAll } from 'vitest';

// Minimal window/localStorage polyfill so the client-store module (browser-
// guarded persistence helpers at import time) loads in the node environment —
// same pattern as client-store-persistence.test.ts.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  },
};

import { preserveAbnormalEndDraft } from '../client-store';
import { ABNORMAL_END_DRAFT_NOTE_DE, TIMEOUT_DRAFT_NOTE_DE } from '../statusLabels';

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('preserveAbnormalEndDraft — draft survival on every abnormal end (LP-2)', () => {
  it('keeps a non-empty streamed draft on timeout with the timeout note', () => {
    const draft = 'Die DORA-Verordnung regelt die digitale Betriebsstabilität. [R-DORA-001]';
    const preserved = preserveAbnormalEndDraft('timeout', draft);
    expect(preserved).toBe(`${draft}${TIMEOUT_DRAFT_NOTE_DE}`);
  });

  it('returns null for an empty or whitespace-only draft (normal error row)', () => {
    expect(preserveAbnormalEndDraft('timeout', '')).toBeNull();
    expect(preserveAbnormalEndDraft('internal_error', '   \n  ')).toBeNull();
  });

  it('preserves drafts for EVERY abnormal end code, not just timeout (LP-2)', () => {
    const draft = 'Ein bereits gestreamter Berichtsteil. [R-DORA-001]';
    for (const code of ['internal_error', 'upstream_error', 'stream_closed', 'network_error', 'stream_interrupted']) {
      expect(preserveAbnormalEndDraft(code, draft)).toBe(`${draft}${ABNORMAL_END_DRAFT_NOTE_DE}`);
    }
  });

  it('note is German, central, rendered as a callout, and names the unverified status', () => {
    expect(TIMEOUT_DRAFT_NOTE_DE).toContain('> ⚠️');
    expect(TIMEOUT_DRAFT_NOTE_DE).toContain('Antwort unvollständig');
    // Review finding: the preserved draft never ran through verifyResponse —
    // the note must say so, never present the draft as checked content.
    expect(TIMEOUT_DRAFT_NOTE_DE).toContain('nicht verifiziert');
    expect(TIMEOUT_DRAFT_NOTE_DE).toContain('manuell prüfen');
    expect(TIMEOUT_DRAFT_NOTE_DE).not.toMatch(/\b(the|and|response|timeout)\b/i);
  });
});

describe('buildMessageMeta — verification fallback honesty (F7)', () => {
  it('missing verification metadata yields ok:"unknown" — never a fabricated all-pass', async () => {
    const { buildMessageMeta } = await import('../client-store');
    const meta = buildMessageMeta({ mode: 'CONVERSATIONAL', model: 'claude' }, []);
    expect(meta.verification).toEqual({ ok: 'unknown' });
  });

  it('server-provided verification passes through untouched', async () => {
    const { buildMessageMeta } = await import('../client-store');
    const verification = {
      ok: false as const,
      failed: 'citation_coverage',
      reason: 'Zwei Aussagen ohne Beleg.',
    };
    const meta = buildMessageMeta({ verification }, ['R-DORA-001']);
    expect(meta.verification).toEqual(verification);
    expect(meta.citations).toEqual(['R-DORA-001']);
  });
});

describe('apiErrorMessageDe — German error rendering (LP-6/F5)', () => {
  it('always translates internal codes, dropping English internals', async () => {
    const { apiErrorMessageDe } = await import('../statusLabels');
    expect(apiErrorMessageDe('upstream_error', 'Anthropic API returned 5xx.')).toMatch(
      /KI-Dienst/,
    );
    expect(apiErrorMessageDe('internal_error', 'Unexpected error. Check server logs.')).toMatch(
      /Unerwarteter Fehler/,
    );
  });

  it('prefers the (German) server message for non-internal codes', async () => {
    const { apiErrorMessageDe } = await import('../statusLabels');
    expect(apiErrorMessageDe('rate_limited', 'Upload-Limit erreicht (20 pro Stunde).')).toBe(
      'Upload-Limit erreicht (20 pro Stunde).',
    );
  });

  it('falls back to the code map, then to a generic German message', async () => {
    const { apiErrorMessageDe } = await import('../statusLabels');
    expect(apiErrorMessageDe('rate_limited', undefined)).toMatch(/Limit erreicht/);
    expect(apiErrorMessageDe('some_new_code', undefined, 503)).toBe(
      'Fehler (HTTP 503). Bitte erneut versuchen.',
    );
    expect(apiErrorMessageDe(undefined, undefined)).toMatch(/Unerwarteter Fehler/);
  });

  it('never renders raw "code: message" concatenation', async () => {
    const { apiErrorMessageDe } = await import('../statusLabels');
    const out = apiErrorMessageDe('upstream_error', 'boom');
    expect(out).not.toContain('upstream_error');
    expect(out).not.toContain(':  ');
  });
});

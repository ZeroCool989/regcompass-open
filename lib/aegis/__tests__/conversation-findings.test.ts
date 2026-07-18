import { describe, expect, it, vi } from 'vitest';
import {
  ExtractedItem,
  enforceItemCitations,
  extractConversationFindings,
  isUnverifiedSource,
  toGapFindings,
} from '../conversation-findings';
import {
  FILL_CONVERSATION_NOT_FOUND_DE,
  UNVERIFIED_SOURCE_NOTE_DE,
} from '../statusLabels';
import type { MemoryMessage } from '../memory';
import type { ExtractDeps } from '../conversation-findings';

// ───────────────────────── Fixtures ─────────────────────────

const CONV = 'conv-1';

function makeMessage(over: Partial<MemoryMessage> = {}): MemoryMessage {
  return {
    id: 'm-1',
    seq: 2,
    role: 'assistant',
    content:
      'Bewertung: Für die Datenhaltung fehlen dokumentierte Löschkonzepte nach den Grundsätzen der DSGVO [R-GDPR-005].',
    citedIds: ['R-GDPR-005'],
    status: 'complete',
    exitReason: 'done',
    model: 'claude-sonnet-4-6',
    mode: 'ASSESS',
    toolCalls: null,
    createdAt: new Date('2026-07-06T10:00:00Z'),
    ...over,
  };
}

function item(over: Partial<ExtractedItem> = {}): ExtractedItem {
  return ExtractedItem.parse({
    findingType: 'finding',
    title: 'Fehlende Löschkonzepte',
    description: 'Es fehlen dokumentierte Löschkonzepte für personenbezogene Daten.',
    citations: ['R-GDPR-005'],
    severity: 'High',
    confidence: 0.9,
    sourceContext: 'Abschnitt Datenhaltung',
    status: 'missing',
    ...over,
  });
}

/**
 * callStructured stub that dispatches on the schema: the classification call
 * (containsFindings) vs. the extraction call (items). Returns the typed dep
 * (`call`) plus the raw spy for assertions — callStructured's generic
 * signature can't be satisfied by a concrete mock without the cast.
 */
const USAGE = { input_tokens: 1, output_tokens: 1 };
type CallParams = { schema: Record<string, unknown>; prompt: string };
function makeCall(opts: { containsFindings?: boolean; items?: unknown[] }) {
  const spy = vi.fn(async (params: CallParams) => {
    const isClassify = JSON.stringify(params.schema).includes('containsFindings');
    if (isClassify) {
      return { value: { containsFindings: opts.containsFindings ?? true }, usage: USAGE };
    }
    return { value: { items: opts.items ?? [] }, usage: USAGE };
  });
  return { spy, call: spy as unknown as NonNullable<ExtractDeps['call']> };
}

function loaderFor(messages: MemoryMessage[]) {
  return vi.fn(async () => ({ messages }));
}

// ───────────────────────── (c) Ownership FIRST ─────────────────────────

describe('ownership gate', () => {
  it('foreign/unknown conversation → not-found error BEFORE any extraction', async () => {
    const { call, spy } = makeCall({});
    await expect(
      extractConversationFindings(
        { conversationId: 'foreign', sessionId: 's-1' },
        { call, loadOwnedTranscript: vi.fn(async () => null) },
      ),
    ).rejects.toThrow(FILL_CONVERSATION_NOT_FOUND_DE);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ───────────────────────── (f) Mode-aware Extraktion ─────────────────────────

describe('mode-aware extraction & deterministic column mapping', () => {
  it('ASSESS → finding: FND-id, status as stated, KB-derived regulation (no classify call)', async () => {
    const { call, spy } = makeCall({ items: [item()] });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'ASSESS' })]) },
    );

    expect(spy).toHaveBeenCalledTimes(1); // extraction only — no classification gate
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe('FND-001');
    expect(f.status).toBe('missing');
    expect(f.requirementId).toBe('R-GDPR-005');
    expect(f.regulation).toBe('GDPR');
    expect(f.policySection).toBe('Chat-Analyse (ASSESS)');
    expect(f.manualReview).toBeFalsy();
  });

  it('GAP_ANALYZE → gap: GAP-id, Soll/Ist mapping, status partial|missing', async () => {
    const gapItem = item({
      findingType: 'gap',
      requirement: 'IKT-Risikomanagement nach DORA [R-GDPR-005]',
      currentState: 'Kein dokumentierter Prozess vorhanden.',
      status: 'partial',
      sourceContext: '',
    });
    const { call, spy } = makeCall({ items: [gapItem] });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'GAP_ANALYZE' })]) },
    );

    const f = findings[0];
    expect(f.id).toBe('GAP-001');
    expect(f.status).toBe('partial');
    expect(f.policyExcerpt).toBe('Kein dokumentierter Prozess vorhanden.');
    expect(f.gapDescription).not.toContain('[EMPFEHLUNG]');
  });

  it('CONTROL_ADVISE → recommendation: REC-id, marked as Empfehlung, NEVER a Mangel', async () => {
    const rec = item({
      findingType: 'recommendation',
      rationale: 'Reduziert das operationelle Risiko deutlich.',
    });
    const { call, spy } = makeCall({ items: [rec] });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'CONTROL_ADVISE' })]) },
    );

    const f = findings[0];
    expect(f.id).toBe('REC-001');
    expect(f.status).toBe('not_applicable');
    expect(f.gapDescription.startsWith('[EMPFEHLUNG]')).toBe(true);
    expect(f.recommendation).toBe(rec.description);
    expect(f.reason).toContain('kein festgestellter Mangel');
  });

  it('CONVERSATIONAL without findings → classified out, NO extraction, empty result', async () => {
    const { call, spy } = makeCall({ containsFindings: false, items: [item()] });
    const { findings, sourceRef } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      {
        call,
        loadOwnedTranscript: loaderFor([
          makeMessage({ mode: 'CONVERSATIONAL', content: 'DORA ist eine EU-Verordnung zur digitalen Resilienz.' }),
        ]),
      },
    );

    expect(spy).toHaveBeenCalledTimes(1); // classification only
    expect(findings).toHaveLength(0);
    expect(sourceRef.messageIds).toHaveLength(0);
  });

  it('CONVERSATIONAL with findings → classification gate passes, then extraction', async () => {
    const { call, spy } = makeCall({ containsFindings: true, items: [item()] });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'CONVERSATIONAL' })]) },
    );
    expect(spy).toHaveBeenCalledTimes(2); // classify + extract
    expect(findings).toHaveLength(1);
  });
});

// ───────────────────────── (d) Citation-Firewall ─────────────────────────

describe('citation firewall', () => {
  it('strips fabricated [R-…] IDs from citations and free text', () => {
    const source = 'Analyse mit Beleg [R-GDPR-005] im Text.';
    const bad = item({
      citations: ['R-GDPR-005', 'R-FAKE-999'],
      description: 'Löschkonzepte fehlen [R-FAKE-999] laut Bewertung.',
    });
    const { items, fabricated } = enforceItemCitations([bad], source);

    expect(items[0].citations).toEqual(['R-GDPR-005']);
    expect(items[0].description).not.toContain('R-FAKE-999');
    expect(fabricated).toContain('[R-FAKE-999]');
  });

  it('covers ALL free-text fields — title/regulation/article too (review fix)', () => {
    const source = 'Analyse ohne Belege.';
    const bad = item({
      title: 'Befund [R-FAKE-111] mit Token',
      regulation: 'DORA [R-FAKE-222]',
      article: 'Art. 5 [R-FAKE-333]',
      description: 'Beschreibung des Befunds ohne fabrizierte Tokens.',
      citations: [],
    });
    const { items, fabricated } = enforceItemCitations([bad], source);

    expect(items[0].title).not.toContain('R-FAKE-111');
    expect(items[0].regulation).not.toContain('R-FAKE-222');
    expect(items[0].article).not.toContain('R-FAKE-333');
    expect(fabricated).toEqual(
      expect.arrayContaining(['[R-FAKE-111]', '[R-FAKE-222]', '[R-FAKE-333]']),
    );
  });

  it('KB precedence: the verified citation beats the model-extracted regulation name', async () => {
    const { call } = makeCall({
      items: [item({ regulation: 'Falsche Verordnung', article: 'Art. 99' })],
    });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage()]) },
    );
    // Citation R-GDPR-005 resolves in the KB → its regulation/article win.
    expect(findings[0].regulation).toBe('GDPR');
    expect(findings[0].article).toBe('Art. 5');
  });

  it('end-to-end: fabricated ID never reaches the GapFinding', async () => {
    const { call, spy } = makeCall({
      items: [item({ citations: ['R-FAKE-999'], description: 'Beschreibung ohne echten Beleg im Quelltext.' })],
    });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ content: 'Antwort ohne Citations.' })]) },
    );
    expect(findings[0].citations).toEqual([]);
    expect(findings[0].requirementId).toBe('');
  });
});

// ───────────────────────── (e) Unverifizierte Quellen ─────────────────────────

describe('unverified sources', () => {
  it('isUnverifiedSource: exitReason verify_degraded and banner markers', () => {
    expect(isUnverifiedSource({ exitReason: 'verify_degraded', content: 'x' })).toBe(true);
    expect(isUnverifiedSource({ exitReason: 'done', content: '> ⚠️ **Verifizierung unvollständig:** …' })).toBe(true);
    expect(
      isUnverifiedSource({ exitReason: 'done', content: '> ⚠️ **Antwort unvollständig — nicht verifiziert:** …' }),
    ).toBe(true);
    expect(isUnverifiedSource({ exitReason: 'done', content: 'Saubere Antwort. [R-GDPR-005]' })).toBe(false);
  });

  it('verify_degraded message → findings marked (manualReview + Hinweis), listed in sourceRef', async () => {
    const { call, spy } = makeCall({ items: [item()] });
    const { findings, sourceRef } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      {
        call,
        loadOwnedTranscript: loaderFor([makeMessage({ exitReason: 'verify_degraded' })]),
      },
    );

    expect(findings[0].manualReview).toBe(true);
    expect(findings[0].evidence).toContain(UNVERIFIED_SOURCE_NOTE_DE);
    expect(sourceRef.unverifiedMessageIds).toEqual(['m-1']);
  });

  it('failed/empty messages are excluded entirely (no extraction call)', async () => {
    const { call, spy } = makeCall({ items: [item()] });
    const { findings } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      {
        call,
        loadOwnedTranscript: loaderFor([
          makeMessage({ status: 'failed', content: '' }),
          makeMessage({ id: 'm-2', role: 'user', content: 'Frage?' }),
        ]),
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(findings).toHaveLength(0);
  });
});

// ───────────────────────── (g) messageIds-Filter ─────────────────────────

describe('messageIds filter', () => {
  it('only the named messages are extracted', async () => {
    const m1 = makeMessage({ id: 'm-1', content: 'Erste Analyse [R-GDPR-005].' });
    const m2 = makeMessage({ id: 'm-2', seq: 4, content: 'Zweite Analyse [R-GDPR-005].' });
    const { call, spy } = makeCall({ items: [item()] });

    const { sourceRef } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1', messageIds: ['m-2'] },
      { call, loadOwnedTranscript: loaderFor([m1, m2]) },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].prompt).toBe(m2.content);
    expect(sourceRef.messageIds).toEqual(['m-2']);
  });
});

// ───────────────────────── (b) Provenienz ─────────────────────────

describe('provenance record', () => {
  it('sourceRef carries kind, ids, mode per message and a timestamp', async () => {
    const { call, spy } = makeCall({ items: [item()] });
    const { sourceRef } = await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'ASSESS' })]) },
    );

    expect(sourceRef.kind).toBe('conversation');
    expect(sourceRef.conversationId).toBe(CONV);
    expect(sourceRef.messageIds).toEqual(['m-1']);
    expect(sourceRef.modeByMessage).toEqual({ 'm-1': 'ASSESS' });
    expect(Number.isNaN(Date.parse(sourceRef.extractedAt))).toBe(false);
  });
});

// ───────────────────────── Mapping-Kanten ─────────────────────────

describe('deterministic mapping edges', () => {
  it('low extraction confidence → manualReview', () => {
    const counters = { finding: 0, gap: 0, recommendation: 0 } as const;
    const [f] = toGapFindings([item({ confidence: 0.3 })], {
      conversationId: CONV,
      messageId: 'm-1',
      mode: 'ASSESS',
      unverified: false,
      counters: { ...counters },
    });
    expect(f.manualReview).toBe(true);
  });

  it('numbering is continuous per findingType across items', () => {
    const counters = { finding: 0, gap: 0, recommendation: 0 };
    const out = toGapFindings(
      [item(), item({ findingType: 'recommendation' }), item()],
      { conversationId: CONV, messageId: 'm-1', mode: 'ASSESS', unverified: false, counters },
    );
    expect(out.map((f) => f.id)).toEqual(['FND-001', 'REC-001', 'FND-002']);
  });

  it('unstated severity/status → deterministic default + manualReview (model never scores)', () => {
    const counters = { finding: 0, gap: 0, recommendation: 0 };
    const [f] = toGapFindings([item({ severity: undefined, status: undefined })], {
      conversationId: CONV,
      messageId: 'm-1',
      mode: 'ASSESS',
      unverified: false,
      counters,
    });
    expect(f.severity).toBe('Medium'); // deterministic TS default, not a model choice
    expect(f.status).toBe('missing');
    expect(f.manualReview).toBe(true);
    expect(f.reason).toContain('deterministischer Default');
  });
});

// ───────────────────────── Cost-Hook ─────────────────────────

describe('usage accounting', () => {
  it('reports every classification and extraction call via onUsage', async () => {
    const { call } = makeCall({ containsFindings: true, items: [item()] });
    const onUsage = vi.fn();
    await extractConversationFindings(
      { conversationId: CONV, sessionId: 's-1' },
      { call, loadOwnedTranscript: loaderFor([makeMessage({ mode: 'CONVERSATIONAL' })]), onUsage },
    );
    expect(onUsage).toHaveBeenCalledTimes(2); // Haiku classify + Sonnet extract
    const models = onUsage.mock.calls.map((c) => String(c[0]));
    expect(models.some((m) => m.includes('haiku'))).toBe(true);
    expect(models.some((m) => m.includes('sonnet'))).toBe(true);
    expect(onUsage.mock.calls[0][1]).toEqual({ input_tokens: 1, output_tokens: 1 });
  });
});

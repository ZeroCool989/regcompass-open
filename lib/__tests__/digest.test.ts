import { describe, expect, it, vi } from 'vitest';
import {
  applyDigestToSeed,
  buildDigestInput,
  citationMetrics,
  DigestInputTooLargeError,
  digestToSeed,
  enforceCitations,
  extractCitations,
  generateDigest,
  MAX_DIGEST_INPUT_TOKENS,
  renderDigestText,
  type ConversationDigest,
  type DigestMessage,
} from '@/lib/aegis/digest';
import { MemoryConfig } from '@/lib/aegis/memory-config';

describe('digest input limit comes from MemoryConfig', () => {
  it('MAX_DIGEST_INPUT_TOKENS equals the configured digest limit', () => {
    expect(MAX_DIGEST_INPUT_TOKENS).toBe(MemoryConfig.digestMaxInputTokens);
  });
});

const sample: ConversationDigest = {
  decisions: ['Nutzer wählt EU AI Act als Referenzrahmen'],
  openTasks: ['DSFA noch offen'],
  conclusions: ['Hochrisiko-System gemäss [R-EUAIA-0006]'],
  preferencesObserved: ['möchte zuerst die Umsetzung'],
};

describe('digest pure helpers', () => {
  it('renderDigestText preserves citation IDs verbatim', () => {
    const text = renderDigestText(sample);
    expect(text).toContain('[R-EUAIA-0006]');
    expect(text).toContain('Entscheidungen');
    expect(text).toContain('Offene Aufgaben');
  });

  it('digestToSeed produces a valid user→assistant pair', () => {
    const seed = digestToSeed(sample);
    expect(seed).toHaveLength(2);
    expect(seed[0].role).toBe('user');
    expect(seed[1].role).toBe('assistant');
    expect(seed[1].content).toContain('[R-EUAIA-0006]');
  });

  it('applyDigestToSeed prepends the digest pair before later turns', () => {
    const post = [
      { role: 'user' as const, content: 'Neue Frage' },
      { role: 'assistant' as const, content: 'Neue Antwort' },
    ];
    const out = applyDigestToSeed(sample, post);
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe('user'); // alternation preserved
    expect(out[2].content).toBe('Neue Frage');
  });

  it('buildDigestInput orders turns by seq and labels roles', () => {
    const msgs: DigestMessage[] = [
      { role: 'assistant', content: 'B', seq: 1 },
      { role: 'user', content: 'A', seq: 0 },
    ];
    const input = buildDigestInput(msgs);
    expect(input.indexOf('NUTZER: A')).toBeLessThan(input.indexOf('AEGIS: B'));
  });
});

describe('generateDigest', () => {
  it('calls the model with the schema and keeps citations present in the source', async () => {
    const call = vi.fn().mockResolvedValue({ value: sample, usage: {} });
    const out = await generateDigest(
      [
        { role: 'user', content: 'Ist das ein Hochrisiko-System?', seq: 0 },
        { role: 'assistant', content: 'Ja, gemäss [R-EUAIA-0006].', seq: 1 },
      ],
      { call: call as never },
    );
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0][0]).toMatchObject({ schema: expect.any(Object) });
    expect(out.conclusions.join(' ')).toContain('[R-EUAIA-0006]');
  });

  it('drops non-string / missing fields defensively', async () => {
    const call = vi.fn().mockResolvedValue({
      value: { decisions: ['ok', 42, null], conclusions: undefined },
      usage: {},
    });
    const out = await generateDigest([{ role: 'user', content: 'x', seq: 0 }], { call: call as never });
    expect(out.decisions).toEqual(['ok']);
    expect(out.conclusions).toEqual([]);
    expect(out.openTasks).toEqual([]);
  });

  it('strips fabricated citations so fabricationRate === 0', async () => {
    // Model invents [R-FAKE-999]; source only has [R-FINMA-0824].
    const call = vi.fn().mockResolvedValue({
      value: {
        decisions: [],
        openTasks: [],
        conclusions: [
          'Governance erforderlich [R-FINMA-0824]',
          'Erfundene Schlussfolgerung [R-FAKE-999]',
        ],
        preferencesObserved: [],
      },
      usage: {},
    });
    const source: DigestMessage[] = [
      { role: 'user', content: 'Was fordert die Aufsicht?', seq: 0 },
      { role: 'assistant', content: 'Governance [R-FINMA-0824].', seq: 1 },
    ];
    const out = await generateDigest(source, { call: call as never });
    const joined = out.conclusions.join(' ');
    expect(joined).toContain('[R-FINMA-0824]');
    expect(joined).not.toContain('[R-FAKE-999]');

    const metrics = citationMetrics(out, buildDigestInput(source));
    expect(metrics.fabricationRate).toBe(0);
    expect(metrics.fabricated).toEqual([]);
  });

  it('refuses an oversized transcript before spending a model call', async () => {
    const call = vi.fn();
    const huge: DigestMessage[] = [
      { role: 'user', content: 'x'.repeat(MAX_DIGEST_INPUT_TOKENS * 4), seq: 0 },
    ];
    await expect(generateDigest(huge, { call: call as never })).rejects.toBeInstanceOf(
      DigestInputTooLargeError,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

describe('citation firewall (pure)', () => {
  it('removes fabricated tokens and reports them', () => {
    const d: ConversationDigest = {
      decisions: ['Wahl [R-EUAIA-0006]'],
      openTasks: [],
      conclusions: ['Falsch [R-FAKE-1]'],
      preferencesObserved: [],
    };
    const { digest, fabricated } = enforceCitations(d, 'Quelle [R-EUAIA-0006] hier.');
    expect(fabricated).toEqual(['[R-FAKE-1]']);
    expect(digest.decisions[0]).toContain('[R-EUAIA-0006]');
    expect(digest.conclusions.join(' ')).not.toContain('[R-FAKE-1]');
  });

  it('citationMetrics computes retention and fabricationRate', () => {
    const d: ConversationDigest = {
      decisions: [],
      openTasks: [],
      conclusions: ['A [R-FINMA-0824]', 'B [R-FAKE-9]'],
      preferencesObserved: [],
    };
    const source = 'Quelle [R-FINMA-0824] und [R-DSGVO-0035].';
    const m = citationMetrics(d, source);
    expect(m.sourceCount).toBe(2);
    expect(m.fabricated).toEqual(['[R-FAKE-9]']);
    expect(m.missing).toEqual(['[R-DSGVO-0035]']);
    expect(m.retention).toBeCloseTo(0.5);
    expect(m.fabricationRate).toBeCloseTo(0.5);
  });

  it('extractCitations matches the canonical token format', () => {
    const set = extractCitations('a [R-FINMA-0824] b [R-X-1] c [R-bad] d');
    expect(set.has('[R-FINMA-0824]')).toBe(true);
    expect(set.has('[R-X-1]')).toBe(true);
    expect(set.has('[R-bad]')).toBe(false); // lowercase → not a citation
  });
});

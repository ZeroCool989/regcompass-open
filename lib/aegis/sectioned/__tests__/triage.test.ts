import { describe, expect, it, vi } from 'vitest';
import {
  classifyTriage,
  countNumberedSections,
  heuristicSignals,
  resolveStrategy,
  FALLBACK_TRIAGE,
} from '../triage';
import { COMPLIANCE_FIXTURE_PROMPT } from './fixtures';

const stubCall = (text: string) =>
  vi.fn().mockResolvedValue({ text, usage: { input_tokens: 50, output_tokens: 20 } });

describe('countNumberedSections', () => {
  it('counts distinct numbered top-level lines', () => {
    expect(countNumberedSections('1. Eins\n2. Zwei\n3) Drei\ntext\n4. Vier')).toBe(4);
  });
  it('does not double-count repeated numbering (nested re-numbered lists)', () => {
    expect(countNumberedSections('1. A\n2. B\n1. sub\n2. sub')).toBe(2);
  });
  it('ignores inline numbers and dates', () => {
    expect(countNumberedSections('Seit 2025 gilt DORA. Art. 5 Abs. 1 nennt 3 Punkte.')).toBe(0);
  });
});

describe('heuristicSignals', () => {
  it('fires "sections" for the compliance fixture (9 numbered sections)', () => {
    expect(countNumberedSections(COMPLIANCE_FIXTURE_PROMPT)).toBeGreaterThanOrEqual(5);
    expect(heuristicSignals(COMPLIANCE_FIXTURE_PROMPT)).toContain('sections');
  });

  it('fires "keywords" for an explicit catalogue ask', () => {
    expect(heuristicSignals('Erstelle einen Compliance-Katalog für unsere KI-Systeme.')).toContain(
      'keywords',
    );
  });

  it('fires "input_tokens" for very long unstructured input', () => {
    const long = 'Bitte analysiere unsere Auslagerungsvereinbarung im Detail. '.repeat(200);
    expect(heuristicSignals(long)).toContain('input_tokens');
  });

  it('does not fire on word-embedded keywords (Berichterstattung, reporting)', () => {
    const signals = heuristicSignals(
      'Wie ist die Berichterstattung nach DORA geregelt und was gilt für reporting?',
    );
    expect(signals).not.toContain('keywords');
  });

  it('SINGLE_PASS regression: a short question produces no signals', () => {
    expect(heuristicSignals('Was ist DORA?')).toHaveLength(0);
  });
});

describe('resolveStrategy', () => {
  it('SECTIONED when a heuristic signal fired', () => {
    expect(resolveStrategy(['sections'], 'question').deliverableStrategy).toBe('SECTIONED');
  });
  it('SECTIONED via normalised kind report/catalogue (adds the "kind" signal)', () => {
    const r = resolveStrategy([], 'catalogue');
    expect(r.deliverableStrategy).toBe('SECTIONED');
    expect(r.signals).toEqual(['kind']);
  });
  it('SINGLE_PASS for question/assessment without heuristic signals', () => {
    expect(resolveStrategy([], 'question').deliverableStrategy).toBe('SINGLE_PASS');
    expect(resolveStrategy([], 'assessment').deliverableStrategy).toBe('SINGLE_PASS');
  });
});

describe('classifyTriage', () => {
  it('merges Haiku result with heuristics (compliance fixture → SECTIONED)', async () => {
    const call = stubCall('{"mode":"CONTROL_ADVISE","complexity":0.9,"deliverableKind":"catalogue"}');
    const r = await classifyTriage(COMPLIANCE_FIXTURE_PROMPT, call);
    expect(r.mode).toBe('CONTROL_ADVISE');
    expect(r.complexity).toBe(0.9);
    expect(r.deliverableKind).toBe('catalogue');
    expect(r.deliverableStrategy).toBe('SECTIONED');
    expect(r.signals).toEqual(expect.arrayContaining(['sections', 'kind']));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('normalises a rephrased/typo report ask via deliverableKind alone', async () => {
    const call = stubCall('{"mode":"CONVERSATIONAL","complexity":0.6,"deliverableKind":"report"}');
    const r = await classifyTriage('bitte ein ausfürliches gutachtn zu unserem chatbot machen', call);
    expect(r.deliverableStrategy).toBe('SECTIONED');
    expect(r.signals).toContain('kind');
  });

  it('SINGLE_PASS regression: plain question stays single-pass with intact mode/complexity', async () => {
    const call = stubCall('{"mode":"CONVERSATIONAL","complexity":0.2,"deliverableKind":"question"}');
    const r = await classifyTriage('Was ist DORA?', call);
    expect(r.deliverableStrategy).toBe('SINGLE_PASS');
    expect(r.mode).toBe('CONVERSATIONAL');
    expect(r.complexity).toBe(0.2);
    expect(r.signals).toHaveLength(0);
  });

  it('fail-open: Haiku error → heuristics alone decide (never throws)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    const sectioned = await classifyTriage(COMPLIANCE_FIXTURE_PROMPT, call);
    expect(sectioned.deliverableStrategy).toBe('SECTIONED'); // heuristics carry it
    expect(sectioned.mode).toBe(FALLBACK_TRIAGE.mode);

    const single = await classifyTriage('Was ist DORA?', call);
    expect(single).toMatchObject(FALLBACK_TRIAGE);
  });

  it('fail-open: malformed Haiku JSON → heuristics alone decide', async () => {
    const call = stubCall('not json at all');
    const r = await classifyTriage('Was ist DORA?', call);
    expect(r).toMatchObject(FALLBACK_TRIAGE);
  });

  it('rejects an unknown deliverableKind to "question" instead of failing', async () => {
    const call = stubCall('{"mode":"CONVERSATIONAL","complexity":0.4,"deliverableKind":"poem"}');
    const r = await classifyTriage('Was ist DORA?', call);
    expect(r.deliverableKind).toBe('question');
    expect(r.deliverableStrategy).toBe('SINGLE_PASS');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyIntent,
  estimateComplexity,
  getIntentClassifier,
  routeToModel,
  type CallModelFn,
} from '../router';
import { MODEL_IDS } from '../types';

// ───────────────────────── classifyIntent ─────────────────────────

const goodResponse = (mode: string, complexity: number): CallModelFn =>
  async () => ({ text: `{"mode":"${mode}","complexity":${complexity}}` });

const wrappedResponse: CallModelFn = async () => ({
  text: 'Sure! Here is your classification:\n{"mode":"ASSESS","complexity":0.7}\nLet me know if you need anything else.',
});

const invalidJson: CallModelFn = async () => ({ text: 'not json at all' });

const throwingModel: CallModelFn = async () => {
  throw new Error('upstream boom');
};

describe('classifyIntent', () => {
  it('parses well-formed JSON', async () => {
    const result = await classifyIntent('Was ist DORA?', goodResponse('ASSESS', 0.8));
    expect(result).toEqual({ mode: 'ASSESS', complexity: 0.8 });
  });

  it('extracts JSON from wrapped text', async () => {
    const result = await classifyIntent('test', wrappedResponse);
    expect(result.mode).toBe('ASSESS');
    expect(result.complexity).toBeCloseTo(0.7);
  });

  it('falls back when response is not JSON', async () => {
    const result = await classifyIntent('test', invalidJson);
    expect(result).toEqual({ mode: 'CONVERSATIONAL', complexity: 0.5 });
  });

  it('falls back when mode is invalid', async () => {
    const result = await classifyIntent('test', goodResponse('INVALID_MODE', 0.5));
    expect(result).toEqual({ mode: 'CONVERSATIONAL', complexity: 0.5 });
  });

  it('falls back when complexity is out of range', async () => {
    const result = await classifyIntent('test', goodResponse('ASSESS', 1.5));
    expect(result).toEqual({ mode: 'CONVERSATIONAL', complexity: 0.5 });
  });

  it('falls back when complexity is negative', async () => {
    const result = await classifyIntent('test', goodResponse('ASSESS', -0.3));
    expect(result).toEqual({ mode: 'CONVERSATIONAL', complexity: 0.5 });
  });

  it('falls back when callModel throws', async () => {
    const result = await classifyIntent('test', throwingModel);
    expect(result).toEqual({ mode: 'CONVERSATIONAL', complexity: 0.5 });
  });

  it('accepts string complexity that coerces to a number in range', async () => {
    const stringComplexity: CallModelFn = async () => ({
      text: '{"mode":"CONVERSATIONAL","complexity":"0.4"}',
    });
    const result = await classifyIntent('test', stringComplexity);
    expect(result.mode).toBe('CONVERSATIONAL');
    expect(result.complexity).toBeCloseTo(0.4);
  });
});

// ───────────────────────── routeToModel ─────────────────────────

describe('routeToModel', () => {
  it('ASSESS → Sonnet regardless of complexity', () => {
    const lo = routeToModel('ASSESS', 0.1);
    const hi = routeToModel('ASSESS', 0.9);
    expect(lo.model).toBe(MODEL_IDS.sonnet);
    expect(hi.model).toBe(MODEL_IDS.sonnet);
  });

  it('GAP_ANALYZE → Sonnet', () => {
    const r = routeToModel('GAP_ANALYZE', 0.5);
    expect(r.model).toBe(MODEL_IDS.sonnet);
  });

  it('CONTROL_ADVISE → Opus', () => {
    const r = routeToModel('CONTROL_ADVISE', 0.5);
    expect(r.model).toBe(MODEL_IDS.opus);
  });

  it('CONVERSATIONAL low complexity (≤ 0.5) → Haiku', () => {
    expect(routeToModel('CONVERSATIONAL', 0.0).model).toBe(MODEL_IDS.haiku);
    expect(routeToModel('CONVERSATIONAL', 0.3).model).toBe(MODEL_IDS.haiku);
    expect(routeToModel('CONVERSATIONAL', 0.5).model).toBe(MODEL_IDS.haiku);
  });

  it('CONVERSATIONAL high complexity (> 0.5) escalates to Sonnet', () => {
    expect(routeToModel('CONVERSATIONAL', 0.51).model).toBe(MODEL_IDS.sonnet);
    expect(routeToModel('CONVERSATIONAL', 0.8).model).toBe(MODEL_IDS.sonnet);
    expect(routeToModel('CONVERSATIONAL', 1.0).model).toBe(MODEL_IDS.sonnet);
  });

  it('RouteDecision only carries model + rationale (token/iteration ceilings live in modes.ts)', () => {
    const r = routeToModel('CONVERSATIONAL', 0.2) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(['model', 'rationale']);
    expect('maxTokens' in r).toBe(false);
    expect('maxIterations' in r).toBe(false);
  });

  it('rationale string includes the model choice reasoning', () => {
    expect(routeToModel('CONVERSATIONAL', 0.2).rationale).toMatch(/Haiku/);
    expect(routeToModel('CONVERSATIONAL', 0.8).rationale).toMatch(/Sonnet/);
    expect(routeToModel('CONTROL_ADVISE', 0.5).rationale).toMatch(/Opus/);
  });
});

// ───────────────────── estimateComplexity (3.4) ─────────────────────

describe('estimateComplexity', () => {
  // Assert on the routing boundary (0.5) — robust to exact-score tuning.
  const escalates = (m: string) => estimateComplexity(m) > 0.5;

  it('keeps a short single-regulation factual question on Haiku', () => {
    expect(escalates('Was ist DORA?')).toBe(false);
    expect(escalates('Which articles of the EU AI Act cover transparency?')).toBe(false);
  });

  it('keeps trivial non-regulatory prompts on Haiku', () => {
    expect(escalates('Hallo, wer bist du?')).toBe(false);
  });

  it('escalates a multi-regulation comparison to Sonnet', () => {
    expect(escalates('Compare GDPR and the EU AI Act transparency duties')).toBe(true);
  });

  it('escalates on an explicit cross-regulation keyword', () => {
    expect(escalates('What is the difference for DORA incident reporting?')).toBe(true);
  });

  it('escalates an ambiguous, anchorless longer question (Sonnet bias when uncertain)', () => {
    const ambiguous =
      'How should our organisation approach the various compliance obligations, ' +
      'risks and controls that might apply to the systems we are building this year?';
    expect(ambiguous.length).toBeGreaterThan(140);
    expect(escalates(ambiguous)).toBe(true);
  });

  it('stays within [0,1]', () => {
    const huge = 'Compare GDPR vs DORA vs the EU AI Act '.repeat(40) + '????';
    const s = estimateComplexity(huge);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('feeds routeToModel: multi-reg → Sonnet, short single → Haiku', () => {
    expect(
      routeToModel('CONVERSATIONAL', estimateComplexity('Compare GDPR and DORA')).model,
    ).toBe(MODEL_IDS.sonnet);
    expect(
      routeToModel('CONVERSATIONAL', estimateComplexity('Was ist DORA?')).model,
    ).toBe(MODEL_IDS.haiku);
  });
});

// ───────────────────── getIntentClassifier flag (3.4) ─────────────────────

describe('getIntentClassifier', () => {
  const saved = process.env.AEGIS_INTENT_CLASSIFIER;
  afterEach(() => {
    if (saved === undefined) delete process.env.AEGIS_INTENT_CLASSIFIER;
    else process.env.AEGIS_INTENT_CLASSIFIER = saved;
  });

  it("defaults to 'haiku' when unset (no routing change on deploy)", () => {
    delete process.env.AEGIS_INTENT_CLASSIFIER;
    expect(getIntentClassifier()).toBe('haiku');
  });

  it("returns 'heuristic' only when explicitly set", () => {
    process.env.AEGIS_INTENT_CLASSIFIER = 'heuristic';
    expect(getIntentClassifier()).toBe('heuristic');
  });

  it("treats any other value as 'haiku'", () => {
    process.env.AEGIS_INTENT_CLASSIFIER = 'something-else';
    expect(getIntentClassifier()).toBe('haiku');
  });
});

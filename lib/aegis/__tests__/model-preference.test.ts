import { describe, expect, it } from 'vitest';
import { applyModelPreference, routeToModel } from '../router';
import { MODEL_IDS } from '../types';

const user = (modelHint: string | null) => ({ apiKey: 'k', modelHint, source: 'user' as const });

describe('applyModelPreference (D8)', () => {
  it('upgrades within the floor: ASSESS (Sonnet) + user Opus → Opus, rationale records it', () => {
    const out = applyModelPreference(routeToModel('ASSESS', 0.5), user(MODEL_IDS.opus));
    expect(out.model).toBe(MODEL_IDS.opus);
    expect(out.rationale).toContain('user-preferred');
  });

  it('never downgrades below the mode floor: ASSESS keeps its Sonnet pin', () => {
    const out = applyModelPreference(routeToModel('ASSESS', 0.5), user(MODEL_IDS.haiku));
    expect(out.model).toBe(MODEL_IDS.sonnet);
    expect(out.rationale).toContain('floor wins');
  });

  it('lifts low-complexity CONVERSATIONAL from Haiku to a preferred Sonnet', () => {
    const out = applyModelPreference(routeToModel('CONVERSATIONAL', 0.1), user(MODEL_IDS.sonnet));
    expect(out.model).toBe(MODEL_IDS.sonnet);
  });

  it('ignores preferences when the turn does not run on the user key', () => {
    const base = routeToModel('ASSESS', 0.5);
    expect(applyModelPreference(base, { modelHint: MODEL_IDS.opus, source: 'service' })).toEqual(base);
    expect(applyModelPreference(base, null)).toEqual(base);
    expect(applyModelPreference(base, { apiKey: 'k' } as never)).toEqual(base);
  });

  it('ignores unknown model ids (defense in depth)', () => {
    const base = routeToModel('ASSESS', 0.5);
    expect(applyModelPreference(base, user('gpt-4.1'))).toEqual(base);
    expect(applyModelPreference(base, user(''))).toEqual(base);
    expect(applyModelPreference(base, user(null))).toEqual(base);
  });

  it('equal preference is a no-op with an unchanged rationale', () => {
    const base = routeToModel('ASSESS', 0.5);
    expect(applyModelPreference(base, user(MODEL_IDS.sonnet))).toEqual(base);
  });
});

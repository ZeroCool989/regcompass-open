import { describe, expect, it, vi } from 'vitest';
import {
  AegisPlan,
  normalizePlanOwnership,
  MAX_PLAN_SECTIONS,
  PlanValidationError,
  generatePlan,
} from '../plan';

// ───────────────────────── Fixtures ─────────────────────────

function section(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'Open-Source-Veröffentlichung',
    covers: ['lizenzwahl', 'secrets im repository'],
    coversNot: ['enterprise-integration'],
    kbDomains: [],
    grounded: false,
    outputShape: 'prose',
    estTokens: 1200,
    ...overrides,
  };
}

/** A valid compliance-shaped mini plan: grounded + advisory + catalogue table. */
function validPlan() {
  return {
    sections: [
      section(),
      section({
        title: 'Regulatorik und Governance',
        covers: ['eu ai act einstufung', 'dora anforderungen'],
        kbDomains: ['EU AI Act', 'DORA'],
        grounded: true,
      }),
      section({
        title: 'Compliance-Katalog',
        covers: ['kontrollkatalog'],
        kbDomains: ['EU AI Act'],
        grounded: true,
        outputShape: 'table',
      }),
    ],
    vocab: {
      entities: ['Muster GmbH', 'FlowDesk'],
      jurisdictions: ['EU', 'CH'],
      terminology: ['Auslagerung, nicht Outsourcing'],
      citationStyle: '[R-...] inline',
    },
  };
}

// ───────────────────────── Zod validation ─────────────────────────

describe('AegisPlan validation', () => {
  it('accepts a valid mixed grounded/advisory plan', () => {
    const r = AegisPlan.safeParse(validPlan());
    expect(r.success).toBe(true);
  });

  it(`rejects more than ${MAX_PLAN_SECTIONS} sections`, () => {
    const p = validPlan();
    p.sections = Array.from({ length: MAX_PLAN_SECTIONS + 1 }, (_, i) =>
      section({ title: `Abschnitt ${i}`, covers: [`thema-${i}`], grounded: false }),
    );
    expect(AegisPlan.safeParse(p).success).toBe(false);
  });

  it('rejects covers[] keyword overlap between sections', () => {
    const p = validPlan();
    p.sections[1].covers = ['lizenzwahl', 'dora anforderungen']; // 'lizenzwahl' owned by section 1
    const r = AegisPlan.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('lizenzwahl'))).toBe(true);
    }
  });

  it('normalises case/whitespace in the overlap check', () => {
    const p = validPlan();
    p.sections[1].covers = ['  Lizenzwahl ', 'dora anforderungen'];
    expect(AegisPlan.safeParse(p).success).toBe(false);
  });

  it('rejects a grounded section without kbDomains', () => {
    const p = validPlan();
    p.sections[1].kbDomains = [];
    const r = AegisPlan.safeParse(p);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('grounded'))).toBe(true);
    }
  });

  it('accepts an ungrounded section without kbDomains (advisory content)', () => {
    const p = validPlan();
    p.sections[1].kbDomains = [];
    p.sections[1].grounded = false;
    expect(AegisPlan.safeParse(p).success).toBe(true);
  });

  it('clamps estTokens into [200, AEGIS_SECTION_MAX_TOKENS] instead of rejecting', () => {
    const p = validPlan();
    p.sections[0].estTokens = 5000;
    p.sections[1].estTokens = 50;
    const parsed = AegisPlan.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sections[0].estTokens).toBe(4096);
      expect(parsed.data.sections[1].estTokens).toBe(200);
    }
  });

  it('clamps an over-long section title instead of rejecting (E2E 2026-07-18)', () => {
    const p = validPlan();
    p.sections[0].title = 'T'.repeat(400);
    const parsed = AegisPlan.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sections[0].title).toHaveLength(200);
  });
});

// ───────────────────────── generatePlan ─────────────────────────

describe('generatePlan', () => {
  it('returns the parsed plan from the structured call', async () => {
    const call = vi.fn().mockResolvedValue({
      value: validPlan(),
      usage: { input_tokens: 900, output_tokens: 700 },
    });
    const { plan, usage } = await generatePlan('Analysiere …', 'de', { call });
    expect(plan.sections).toHaveLength(3);
    expect(plan.vocab.entities).toContain('FlowDesk');
    expect(usage.output_tokens).toBe(700);
    // Sonnet is the plan model; the KB whitelist is in the system prompt.
    const params = call.mock.calls[0][0];
    expect(params.model).toContain('sonnet');
    expect(params.system).toContain('DORA');
  });

  it('throws PlanValidationError on a plan that fails the deterministic checks', async () => {
    const bad = validPlan();
    bad.sections[1].kbDomains = []; // grounded without domain
    const call = vi.fn().mockResolvedValue({ value: bad, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(generatePlan('…', 'de', { call })).rejects.toBeInstanceOf(PlanValidationError);
  });

  it('throws PlanValidationError on structurally alien output', async () => {
    const call = vi.fn().mockResolvedValue({ value: { foo: 'bar' }, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(generatePlan('…', 'de', { call })).rejects.toBeInstanceOf(PlanValidationError);
  });
});

describe('plan resilience — array clamping instead of rejection (E2E 2026-07-17)', () => {
  it('clamps over-long covers/kbDomains lists instead of throwing PlanValidationError', () => {
    const section = {
      title: 'Open-Source-Veröffentlichung',
      covers: Array.from({ length: 18 }, (_, i) => `thema-${i}`),
      coversNot: Array.from({ length: 15 }, (_, i) => `fremd-${i}`),
      kbDomains: Array.from({ length: 10 }, (_, i) => `DORA`).map((d, i) => (i === 0 ? d : `${d}-${i}`)),
      grounded: true,
      outputShape: 'prose',
      estTokens: 800,
    };
    const parsed = AegisPlan.safeParse({
      sections: [section],
      vocab: { entities: [], jurisdictions: [], terminology: [], citationStyle: '[R-...]' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sections[0].covers).toHaveLength(12);
      expect(parsed.data.sections[0].coversNot).toHaveLength(12);
      expect(parsed.data.sections[0].kbDomains).toHaveLength(8);
    }
  });

  it('keeps the pinned hard contracts: duplicate covers across sections still reject', () => {
    const base = {
      coversNot: [],
      kbDomains: ['DORA'],
      grounded: true,
      outputShape: 'prose' as const,
      estTokens: 500,
    };
    const parsed = AegisPlan.safeParse({
      sections: [
        { ...base, title: 'Eins', covers: ['lizenz'] },
        { ...base, title: 'Zwei', covers: ['lizenz'] },
      ],
      vocab: { entities: [], jurisdictions: [], terminology: [], citationStyle: '[R-...]' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('normalizePlanOwnership — deterministic disjointness (epic resolution 2026-07-18)', () => {
  const vocab = { entities: [], jurisdictions: [], terminology: [], citationStyle: '[R-...]' };
  const sec = (title: string, covers: string[]) => ({
    title,
    covers,
    coversNot: [],
    kbDomains: ['DORA'],
    grounded: true,
    outputShape: 'prose' as const,
    estTokens: 500,
  });

  it('first claim owns the keyword; later claims are dropped (case-insensitive)', () => {
    const { plan, dedupedKeywords } = normalizePlanOwnership({
      sections: [sec('Eins', ['Externe Modelle', 'lizenz']), sec('Zwei', ['externe modelle', 'secrets'])],
      vocab,
    });
    expect(plan.sections[0].covers).toEqual(['Externe Modelle', 'lizenz']);
    expect(plan.sections[1].covers).toEqual(['secrets']);
    expect(dedupedKeywords).toBe(1);
    expect(AegisPlan.safeParse(plan).success).toBe(true);
  });

  it('a section whose covers empty out merges its title into the previous section and is dropped', () => {
    const { plan, dropped } = normalizePlanOwnership({
      sections: [sec('Eins', ['lizenz']), sec('Doppelt', ['lizenz', 'Lizenz '])],
      vocab,
    });
    expect(plan.sections).toHaveLength(1);
    expect(dropped).toEqual([{ index: 1, title: 'Doppelt' }]);
    expect(plan.sections[0].covers).toContain('Doppelt');
  });

  it('drops outright when the emptied section title is itself already owned', () => {
    const { plan, dropped } = normalizePlanOwnership({
      sections: [sec('Eins', ['doppelt']), sec('Doppelt', ['doppelt'])],
      vocab,
    });
    expect(plan.sections).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(plan.sections[0].covers).toEqual(['doppelt']);
  });

  it('generatePlan survives a plan with overlapping covers (the live E2E shape)', async () => {
    const p = validPlan();
    p.sections[1].covers = [...p.sections[1].covers, p.sections[0].covers[0]];
    const call = vi.fn().mockResolvedValue({ value: p, usage: { input_tokens: 1, output_tokens: 1 } });
    const { plan } = await generatePlan('Analysiere …', 'de', { call });
    expect(plan.sections.length).toBeGreaterThanOrEqual(2);
    const all = plan.sections.flatMap((s) => s.covers.map((c) => c.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
  });
});

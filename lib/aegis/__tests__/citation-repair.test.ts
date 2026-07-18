import { describe, it, expect } from 'vitest';
import {
  isCitationFamily,
  renderAllowedEvidence,
  buildCitationRepairMessages,
  buildRegulationRepairMessages,
  CITATION_REPAIR_NUDGE,
  REGULATION_REPAIR_NUDGE,
} from '../citation-repair';

describe('isCitationFamily', () => {
  it('matches the citation-grounding hard checks only', () => {
    expect(isCitationFamily('citation_coverage')).toBe(true);
    expect(isCitationFamily('unsupported_regulatory_claim')).toBe(true);
    expect(isCitationFamily('no_hallucinated_regulations')).toBe(false);
    expect(isCitationFamily('language_consistency')).toBe(false);
  });
});

describe('renderAllowedEvidence', () => {
  it('renders real KB ids as "[R-…] — Reg Article — Title" (regulation-agnostic)', () => {
    const out = renderAllowedEvidence(new Set(['R-DORA-001', 'R-AIACT-005']));
    expect(out).toMatch(/\[R-DORA-001\] — DORA Art\. 1 — .+/);
    expect(out).toMatch(/\[R-AIACT-005\] — EU AI Act Art\. 5 — .+/);
  });
  it('skips ids that do not resolve in the KB (no fabricated entries)', () => {
    expect(renderAllowedEvidence(new Set(['R-FAKE-999']))).toBe('');
  });
  it('returns empty for no ids', () => {
    expect(renderAllowedEvidence(new Set())).toBe('');
  });
});

describe('buildCitationRepairMessages', () => {
  const seed = [{ role: 'user' as const, content: 'Überblick zu DORA?' }];

  it('keeps the seed, adds the failed draft + an instruction turn with the evidence', () => {
    const msgs = buildCitationRepairMessages(seed, 'DRAFT (Art. 1)', new Set(['R-DORA-001']), 'feedback X');
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual(seed[0]);
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'DRAFT (Art. 1)' });
    const user = msgs[2].content as string;
    expect(user).toContain('[R-DORA-001]');
    expect(user).toContain('feedback X');
    expect(user).toContain(CITATION_REPAIR_NUDGE);
  });

  it('tells the model to drop bare article numbers when no ids are available', () => {
    const msgs = buildCitationRepairMessages(seed, 'DRAFT', new Set(), 'fb');
    const user = msgs[2].content as string;
    expect(user).toMatch(/No KB requirement IDs are available/);
    expect(user).toMatch(/nicht durch die Wissensbasis abgedeckt/);
  });

  it('never instructs inventing ids', () => {
    expect(CITATION_REPAIR_NUDGE).toMatch(/NEVER invent or guess/);
    expect(CITATION_REPAIR_NUDGE).toMatch(/Do NOT rewrite/);
  });
});

describe('buildRegulationRepairMessages', () => {
  const seed = [{ role: 'user' as const, content: 'Sicherheitskonzept prüfen?' }];

  it('keeps the seed, adds the failed draft + an instruction turn with the KB whitelist', () => {
    const msgs = buildRegulationRepairMessages(seed, 'DRAFT mit ISO 27001', 'feedback Y');
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual(seed[0]);
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'DRAFT mit ISO 27001' });
    const user = msgs[2].content as string;
    // The whitelist comes from the live KB — spot-check two known short names.
    expect(user).toContain('DORA');
    expect(user).toContain('EU AI Act');
    expect(user).toContain('feedback Y');
    expect(user).toContain(REGULATION_REPAIR_NUDGE);
  });

  it('never instructs inventing names or ids, and forbids rewriting content', () => {
    expect(REGULATION_REPAIR_NUDGE).toMatch(/NEVER invent regulation names/);
    expect(REGULATION_REPAIR_NUDGE).toMatch(/Do NOT rewrite/);
  });

  it('explicitly forbids substituting a flagged name with a different regulation', () => {
    expect(REGULATION_REPAIR_NUDGE).toMatch(/NEVER substitute a flagged name with a DIFFERENT regulation/);
  });
});

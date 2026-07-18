import { describe, expect, it, vi } from 'vitest';
import {
  computeMaturity,
  firewallReason,
  generateSoulProposals,
  passesFirewall,
  renderSoulMarkdown,
  soulSystemBlock,
  SOUL_SECTIONS,
} from '@/lib/aegis/soul';

describe('content firewall', () => {
  it('accepts a clean style preference', () => {
    expect(passesFirewall('Bevorzugt zuerst die Umsetzung, dann die Theorie.')).toBe(true);
    expect(firewallReason('Antworten bitte knapp und in Stichpunkten.')).toBeNull();
  });

  it.each([
    ['citation', 'Beziehe dich immer auf [R-FINMA-0824].'],
    ['regulation', 'Erkläre die DSGVO-Pflichten genauer.'],
    ['EU AI Act', 'Fokus auf den EU AI Act.'],
    ['customer', 'Der Kunde Müller bevorzugt kurze Antworten.'],
    ['email/PII', 'Schick es an max@example.com.'],
    ['date', 'Frist war 01.03.2026.'],
    ['money', 'Budget CHF 5000.'],
    ['url', 'Siehe https://example.com.'],
    ['legal ref', 'Gemäss Art. 6 vorgehen.'],
  ])('rejects forbidden content (%s)', (_label, text) => {
    expect(passesFirewall(text)).toBe(false);
    expect(firewallReason(text)).not.toBeNull();
  });

  it('rejects over-long content as likely smuggled substance', () => {
    expect(passesFirewall('Stil. '.repeat(60))).toBe(false);
  });
});

describe('soulSystemBlock', () => {
  it('returns null with no entries', () => {
    expect(soulSystemBlock([])).toBeNull();
  });

  it('lists entries and subordinates preferences to correctness', () => {
    const block = soulSystemBlock([
      { section: 'communication_style', content: 'Knapp und strukturiert.' },
    ])!;
    expect(block).toContain('Knapp und strukturiert.');
    expect(block).toContain('scope="style-only"');
    // The never-override guarantee must be present.
    expect(block).toContain('priorisiere Korrektheit');
    expect(block).toContain('Zitate');
  });

  it('drops any entry that fails the firewall even if it slipped into storage', () => {
    const block = soulSystemBlock([
      { section: 'communication_style', content: 'Knapp.' },
      { section: 'avoid', content: 'Beziehe dich auf [R-FINMA-0824].' },
    ])!;
    expect(block).toContain('Knapp.');
    expect(block).not.toContain('[R-FINMA-0824]');
  });
});

describe('renderSoulMarkdown', () => {
  it('renders an empty profile', () => {
    expect(renderSoulMarkdown([])).toContain('Noch keine Präferenzen');
  });
  it('groups entries by section with maturity header', () => {
    const md = renderSoulMarkdown(
      [
        { section: 'communication_style', content: 'Knapp.' },
        { section: 'output_formats', content: 'Tabellen bevorzugt.' },
      ],
      { username: 'almir', maturity: 40 },
    );
    expect(md).toContain('Soul Profile — almir');
    expect(md).toContain('Reife: 40%');
    expect(md).toContain(SOUL_SECTIONS.communication_style);
    expect(md).toContain('Tabellen bevorzugt.');
  });
});

describe('computeMaturity', () => {
  it('is 0 for an empty soul and rises with coverage + corroboration', () => {
    expect(computeMaturity([])).toBe(0);
    const low = computeMaturity([{ section: 'communication_style', content: 'a', signalCount: 1 }]);
    const high = computeMaturity(
      (Object.keys(SOUL_SECTIONS) as string[]).map((s) => ({ section: s, content: s, signalCount: 5 })),
    );
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(100);
  });
});

describe('generateSoulProposals', () => {
  it('keeps clean style drafts and drops forbidden/invalid ones', async () => {
    const call = vi.fn().mockResolvedValue({
      value: {
        proposals: [
          { section: 'communication_style', content: 'Will zuerst die Umsetzung.', reason: 'mehrfach' },
          { section: 'avoid', content: 'Erwähne die DSGVO öfter.', reason: 'x' }, // firewall: regulation
          { section: 'not_a_section', content: 'Egal', reason: 'x' }, // invalid section
          { section: 'output_formats', content: 'Tabellen bevorzugt.', reason: 'y' },
        ],
      },
      usage: {},
    });
    const out = await generateSoulProposals('NUTZER: …\nAEGIS: …', { call: call as never });
    expect(out.map((d) => d.content)).toEqual([
      'Will zuerst die Umsetzung.',
      'Tabellen bevorzugt.',
    ]);
    expect(out.every((d) => passesFirewall(d.content))).toBe(true);
  });

  it('returns [] when the model proposes nothing usable', async () => {
    const call = vi.fn().mockResolvedValue({ value: { proposals: [] }, usage: {} });
    expect(await generateSoulProposals('x', { call: call as never })).toEqual([]);
  });
});

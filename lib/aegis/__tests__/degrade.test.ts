import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REPAIR_RESERVE_MS,
  RETRY_RESERVE_MS,
  FINALIZE_RESERVE_MS,
  countUncitedClaimParagraphs,
  buildDegradationBanner,
  prependDegradationBanner,
  timeLeftMs,
} from '../degrade';

describe('reserves (defaults)', () => {
  it('are positive and ordered repair < retry', () => {
    expect(REPAIR_RESERVE_MS).toBeGreaterThan(0);
    expect(RETRY_RESERVE_MS).toBeGreaterThan(0);
    expect(FINALIZE_RESERVE_MS).toBeGreaterThan(0);
    // A full retry costs more wall-clock than a single repair call.
    expect(RETRY_RESERVE_MS).toBeGreaterThan(REPAIR_RESERVE_MS);
  });
});

describe('reserves (env-overridable)', () => {
  afterEach(() => {
    delete process.env.AEGIS_REPAIR_RESERVE_MS;
    delete process.env.AEGIS_RETRY_RESERVE_MS;
    vi.resetModules();
  });

  it('honours AEGIS_*_RESERVE_MS overrides', async () => {
    process.env.AEGIS_REPAIR_RESERVE_MS = '1234';
    process.env.AEGIS_RETRY_RESERVE_MS = '5678';
    vi.resetModules();
    const mod = await import('../degrade');
    expect(mod.REPAIR_RESERVE_MS).toBe(1234);
    expect(mod.RETRY_RESERVE_MS).toBe(5678);
  });
});

describe('countUncitedClaimParagraphs', () => {
  it('counts only paragraphs that name an article without a [R-...] citation', () => {
    const text = [
      'DORA regelt den Anwendungsbereich (Art. 1).', // uncited → counts
      'Die Meldepflicht ist in Art. 19 geregelt [R-DORA-019].', // cited → no
      'Allgemeine Einleitung ohne Artikelbezug.', // no article → no
      'Auch § 25a und Rz. 4 ohne Beleg.', // uncited (§/Rz) → counts
    ].join('\n\n');
    expect(countUncitedClaimParagraphs(text)).toBe(2);
  });

  it('is regulation-agnostic (EU AI Act, FINMA Randziffern, …)', () => {
    const text = [
      'Der EU AI Act verbietet Praktiken (Art. 5).', // uncited
      'FINMA verlangt dies in Rz. 32 [R-FINMARS2018-CTR].', // cited
      'Kap. 3 BAIT ohne Beleg.', // uncited
    ].join('\n\n');
    expect(countUncitedClaimParagraphs(text)).toBe(2);
  });

  it('returns 0 when every claim is cited or has no article reference', () => {
    expect(countUncitedClaimParagraphs('Reiner Fließtext ohne Artikel.')).toBe(0);
    expect(countUncitedClaimParagraphs('Art. 1 [R-DORA-001].')).toBe(0);
  });
});

describe('buildDegradationBanner / prependDegradationBanner', () => {
  it('renders a German `>` callout with singular/plural and an honest message', () => {
    const one = buildDegradationBanner(1, 'de');
    expect(one).toMatch(/^> ⚠️/);
    expect(one).toContain('Verifizierung unvollständig');
    expect(one).toContain('1 Aussage');
    expect(buildDegradationBanner(3, 'de')).toContain('3 Aussagen');
  });

  it('renders an English variant when language is en', () => {
    const en = buildDegradationBanner(2, 'en');
    expect(en).toMatch(/^> ⚠️/);
    expect(en).toContain('Verification incomplete');
    expect(en).toContain('2 statements');
  });

  it('prepends the banner above the report (count derived from the text, min 1)', () => {
    const report = 'Überblick\n\nDORA gilt (Art. 1).';
    const out = prependDegradationBanner(report, 'de');
    expect(out.startsWith('> ⚠️')).toBe(true);
    expect(out).toContain('1 Aussage'); // one uncited paragraph
    expect(out.endsWith(report)).toBe(true); // original report preserved verbatim
  });
});

describe('timeLeftMs', () => {
  it('is +Infinity when no deadline is supplied (non-streaming / tests)', () => {
    expect(timeLeftMs({})).toBe(Number.POSITIVE_INFINITY);
  });

  it('subtracts the finalize buffer from the remaining wall-clock', () => {
    const now = 1_000_000;
    const left = timeLeftMs({ deadlineAt: now + 100_000, now: () => now });
    expect(left).toBe(100_000 - FINALIZE_RESERVE_MS);
  });

  it('goes negative once the deadline (minus buffer) has passed', () => {
    const now = 1_000_000;
    expect(timeLeftMs({ deadlineAt: now, now: () => now })).toBeLessThan(0);
  });
});

import type { Severity } from '../gap-finding';

/**
 * Parameterized deck theme (target architecture §4: "pptxgenjs with a
 * parameterized DeckTheme"). Every visual constant the writer uses lives here,
 * so a client-branded deck is a theme object — not a fork of the writer.
 *
 * Colors are pptxgenjs hex strings WITHOUT the leading `#`.
 */
export type DeckTheme = {
  /** Font family used on every text run. */
  font: string;
  /** Bright brand accent (top bar, dividers, rails). */
  brand: string;
  /** Accessible brand for text/links on white. */
  brandDeep: string;
  /** Dark background (title slide) / dark table header. */
  slate: string;
  /** Primary body text color. */
  ink: string;
  /** Secondary/muted text color. */
  muted: string;
  /** Page background. */
  paper: string;
  /** Zebra row fill. */
  rowAlt: string;
  /** Subtle content card fill. */
  card: string;
  /** Hairline border color. */
  border: string;
  /** Severity accent colors (badge fills, chart segments). */
  severity: Record<Severity, string>;
  /** Severity tint fills (stat tiles, heatmap cells). */
  severityTint: Record<Severity, string>;
  /** Footer line shown on every content slide. */
  footer: string;
  /** Brand line shown on the title slide kicker. */
  brandLine: string;
  /** Deck author/company metadata. */
  author: string;
  company: string;
};

/** Default RegCompass theme — byte-for-byte the visual system the writer shipped with. */
export const REGCOMPASS_THEME: DeckTheme = {
  font: 'Calibri',
  brand: '00BFFF',
  brandDeep: '0E7FB8',
  slate: '1F2937',
  ink: '111827',
  muted: '6B7280',
  paper: 'FFFFFF',
  rowAlt: 'F3F6F9',
  card: 'F8FAFC',
  border: 'E5E7EB',
  severity: {
    Critical: 'C0392B',
    High: 'E67E22',
    Medium: 'F1C40F',
    Low: '27AE60',
  },
  severityTint: {
    Critical: 'F9E0DC',
    High: 'FCEAD7',
    Medium: 'FDF6D6',
    Low: 'DCF2E5',
  },
  footer: 'AEGIS Management Summary · quellenbasiert (keine erfundenen Aussagen) · keine Rechtsberatung',
  brandLine: 'AEGIS · REGCOMPASS',
  author: 'AEGIS — RegCompass',
  company: 'RegCompass',
};

/**
 * Density controls how much content a slide carries. `normal` is the shipped
 * layout; `compact` is the lint-retry fallback: smaller body fonts and lower
 * row caps so overflowing decks re-render inside their boxes instead of being
 * delivered broken (deck-lint.ts decides when it is used).
 */
export type DeckDensity = 'normal' | 'compact';

export const DENSITY = {
  normal: {
    findingsRows: 11,
    tableFont: 9,
    tableBodyFont: 8.5,
    bulletFont: 12,
    roadmapFont: 10,
    sourcesFont: 10,
    sourcesRows: 30,
  },
  compact: {
    findingsRows: 8,
    tableFont: 8,
    tableBodyFont: 7.5,
    bulletFont: 10.5,
    roadmapFont: 9,
    sourcesFont: 8.5,
    sourcesRows: 22,
  },
} as const satisfies Record<DeckDensity, Record<string, number>>;

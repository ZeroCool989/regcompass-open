/**
 * soul.md personalization engine (Phase 3) — STYLE ONLY.
 *
 * A `soul` is a small set of user preferences about HOW AEGIS communicates:
 * style, structure, formatting, prioritization, learning and decision-support
 * preferences. It is the user's, it is opt-in, and the AI may only *propose*
 * entries — nothing is stored without explicit approval.
 *
 * Hard boundary (enforced by the content firewall below): a soul entry must
 * NEVER contain business, regulatory, RAG/KB, citation, or customer data. The
 * injected block (soulSystemBlock) also instructs the model that preferences
 * never override citations, verification, KB grounding, or regulatory accuracy.
 *
 * Pure + dependency-light so it's unit-testable; the proposal generator injects
 * its model call (mirrors digest.ts).
 */

import { callStructured } from './client';
import { MODEL_IDS } from './types';
import { MemoryConfig } from './memory-config';

export const SOUL_SECTIONS = {
  communication_style: 'Kommunikationsstil',
  output_formats: 'Ausgabeformate',
  decision_support: 'Entscheidungshilfe',
  learning_style: 'Lernstil',
  prioritization: 'Priorisierung',
  avoid: 'Zu vermeiden',
} as const;

export type SoulSection = keyof typeof SOUL_SECTIONS;

export function isSoulSection(s: string): s is SoulSection {
  return Object.prototype.hasOwnProperty.call(SOUL_SECTIONS, s);
}

export interface SoulEntryLike {
  section: string;
  content: string;
  signalCount?: number;
}

// ───────────────────────── Content firewall ─────────────────────────

/** Max length of a style preference — anything longer is likely smuggled content. */
const MAX_ENTRY_CHARS = 240;

/**
 * Patterns that mark business/regulatory/customer/RAG content. A soul entry
 * matching ANY of these is rejected — preferences are about communication
 * STYLE, never substance.
 */
const FIREWALL: Array<{ re: RegExp; reason: string }> = [
  { re: /\[R-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/, reason: 'Zitations-ID' },
  {
    re: /\b(FINMA|DSGVO|GDPR|EU[\s-]?AI[\s-]?Act|EU[\s-]?KI|DORA|FIDLEG|FINIG|FINSA|MiFID|Basel|nLPD|revDSG|ISO[\s-]?\d{4,})\b/i,
    reason: 'Regulierungs-/Gesetzesbezug',
  },
  { re: /\b(kunde|kunden|customer|client|mandant|patient)\b/i, reason: 'Kunden-/Personenbezug' },
  { re: /[\w.+-]+@[\w-]+\.[\w.-]+/, reason: 'E-Mail/PII' },
  { re: /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/, reason: 'konkretes Datum (Faktencharakter)' },
  { re: /\b(CHF|EUR|USD)\s?\d|[$€£]\s?\d/i, reason: 'Geldbetrag' },
  { re: /https?:\/\//i, reason: 'URL' },
  { re: /\b(artikel|art\.|§|paragraph|absatz|abs\.)\s?\d/i, reason: 'Rechtsnorm-Verweis' },
];

/** Returns the firewall reason a content string fails for, or null if it passes. */
export function firewallReason(content: string): string | null {
  const text = content.trim();
  if (text.length === 0) return 'leer';
  if (text.length > MAX_ENTRY_CHARS) return 'zu lang (vermutlich Inhalt statt Stil)';
  for (const { re, reason } of FIREWALL) if (re.test(text)) return reason;
  return null;
}

export function passesFirewall(content: string): boolean {
  return firewallReason(content) === null;
}

// ───────────────────────── Injection (read path) ─────────────────────────

/**
 * The fenced, style-only system block injected into AEGIS. Placed as an
 * UNCACHED trailing block so it never breaks the cached identity+mode prefix,
 * and explicitly subordinated to correctness. Returns null when there are no
 * approved entries (→ no block injected, behaviour unchanged).
 */
export function soulSystemBlock(entries: SoulEntryLike[]): string | null {
  const valid = entries.filter((e) => passesFirewall(e.content));
  if (valid.length === 0) return null;
  const lines = valid.map((e) => `- ${e.content.trim()}`).join('\n');
  return [
    '<personalization scope="style-only">',
    'Kommunikationspräferenzen des Nutzers:',
    lines,
    '',
    'Diese Präferenzen betreffen AUSSCHLIESSLICH Stil, Struktur, Formatierung ' +
      'und Priorisierung der Darstellung. Sie ändern NIEMALS, welche Regulationen ' +
      'gelten, den Inhalt der Wissensbasis, die Zitierpflicht oder die ' +
      'Verifikationsregeln. Wenn eine Präferenz mit regulatorischer Korrektheit, ' +
      'Zitaten, KB-Grounding oder Verifikation in Konflikt steht, IGNORIERE die ' +
      'Präferenz und priorisiere Korrektheit.',
    '</personalization>',
  ].join('\n');
}

// ───────────────────────── Render (soul.md export) ─────────────────────────

export function renderSoulMarkdown(
  entries: SoulEntryLike[],
  opts: { username?: string | null; maturity?: number; updatedAt?: string } = {},
): string {
  const bySection = new Map<string, string[]>();
  for (const e of entries) {
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section)!.push(e.content);
  }
  const header = [
    `# Soul Profile${opts.username ? ` — ${opts.username}` : ''}`,
    `_${opts.maturity != null ? `Reife: ${opts.maturity}%` : 'Neu'}${opts.updatedAt ? ` · Aktualisiert: ${opts.updatedAt}` : ''}_`,
    '',
  ];
  if (entries.length === 0) {
    return [...header, '_Noch keine Präferenzen gespeichert._'].join('\n');
  }
  const body: string[] = [];
  for (const section of Object.keys(SOUL_SECTIONS) as SoulSection[]) {
    const items = bySection.get(section);
    if (!items?.length) continue;
    body.push(`## ${SOUL_SECTIONS[section]}`);
    for (const it of items) body.push(`- ${it}`);
    body.push('');
  }
  return [...header, ...body].join('\n').trimEnd();
}

// ───────────────────────── Maturity score ─────────────────────────

/**
 * Personalization maturity (0–100): how well AEGIS "knows" the user.
 *   coverage      — distinct sections set ÷ total sections (0.6)
 *   corroboration — mean normalized signalCount across entries (0.4)
 * Explainable; a confidence measure, not a target to maximize.
 */
export function computeMaturity(entries: SoulEntryLike[]): number {
  if (entries.length === 0) return 0;
  const sections = new Set(entries.map((e) => e.section));
  const coverage = Math.min(1, sections.size / Object.keys(SOUL_SECTIONS).length);
  const corroboration =
    entries.reduce((sum, e) => sum + Math.min(5, e.signalCount ?? 1) / 5, 0) / entries.length;
  return Math.round((0.6 * coverage + 0.4 * corroboration) * 100);
}

// ───────────────────────── Proposal generator (AI proposes only) ─────────────

export interface SoulProposalDraft {
  section: SoulSection;
  content: string;
  reason: string;
}

const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', enum: Object.keys(SOUL_SECTIONS) },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['section', 'content', 'reason'],
      },
    },
  },
  required: ['proposals'],
};

const PROPOSAL_SYSTEM =
  'Du beobachtest, WIE ein Nutzer mit einem Compliance-Assistenten interagiert, ' +
  'und schlägst kurze STIL-Präferenzen vor (z. B. „bevorzugt zuerst die ' +
  'Umsetzung, dann die Theorie"). STRIKTE REGELN: ' +
  '(1) NUR Kommunikations-/Darstellungsstil — NIEMALS regulatorische, ' +
  'geschäftliche, kundenbezogene oder inhaltliche Informationen. ' +
  '(2) Keine Gesetzes-/Zitatsverweise, keine Namen, keine Daten, keine Beträge. ' +
  '(3) Jede Präferenz max. ein kurzer Satz. ' +
  '(4) Nur Muster vorschlagen, die mehrfach erkennbar sind. ' +
  '(5) section muss einer der erlaubten Schlüssel sein. ' +
  'Wenn keine klaren Stil-Muster erkennbar sind, gib eine leere Liste zurück.';

/**
 * Propose style preferences from a conversation transcript. Firewalled: any
 * draft containing business/regulatory/customer content is dropped, so a
 * proposal can never carry forbidden data even before the user sees it. The
 * model call is injected for testability.
 */
export async function generateSoulProposals(
  transcript: string,
  deps: { call?: typeof callStructured } = {},
): Promise<SoulProposalDraft[]> {
  const call = deps.call ?? callStructured;
  const { value } = await call<{ proposals?: Array<Partial<SoulProposalDraft>> }>({
    model: MODEL_IDS.haiku,
    system: PROPOSAL_SYSTEM,
    prompt: transcript.slice(0, MemoryConfig.soulTranscriptMaxChars),
    schema: PROPOSAL_SCHEMA,
    maxTokens: 1000,
  });
  const drafts = Array.isArray(value?.proposals) ? value.proposals : [];
  return drafts
    .filter(
      (d): d is SoulProposalDraft =>
        typeof d?.section === 'string' &&
        isSoulSection(d.section) &&
        typeof d?.content === 'string' &&
        typeof d?.reason === 'string' &&
        passesFirewall(d.content),
    )
    .map((d) => ({ section: d.section, content: d.content.trim(), reason: d.reason.trim() }));
}

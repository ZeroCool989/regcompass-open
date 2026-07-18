import { CATEGORY_LABELS, label } from '@/lib/kb/labels';
import type { Requirement } from '@/lib/kb/types';
import { regulationShortName } from './gap-finding';

/**
 * Applicability & Coverage Engine — the intelligence that sits BEFORE GapFinding
 * generation. For each KB requirement it decides:
 *   1. Applicability — should this obligation be evaluated against an ICT risk
 *      policy at all? (meta-regulatory / authority-facing requirements are not)
 *   2. Evidence — which policy sentences support a judgement (or none)
 *   3. Coverage — covered / partial / missing, with a confidence score + reason
 *
 * Only Partial/Missing applicable requirements with sufficient confidence become
 * exported gap findings; Covered / Not-Applicable / low-confidence ones are
 * suppressed. This is what turns "58 findings" back into the meaningful few.
 */

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** Configurable via AEGIS_GAP_CONFIDENCE_THRESHOLD (0..1); default 0.70. */
export function getConfidenceThreshold(): number {
  const v = Number(process.env.AEGIS_GAP_CONFIDENCE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_CONFIDENCE_THRESHOLD;
}

// ─────────────────────────── Step 1: Applicability ───────────────────────────

/**
 * Categories that describe how the regulation is governed/enforced rather than
 * obligations a financial entity records in its ICT risk policy.
 */
const META_CATEGORIES = new Set<string>([
  'definitions',
  'scope',
  'enforcement',
  'penalties',
  'cooperation',
  'market-surveillance',
  'codes-of-conduct',
  'transitional-provisions',
  'application-timeline',
  'innovation-support',
]);

/** Title/article phrases that mark a meta-regulatory provision. */
const META_PHRASES = [
  'befugnis',
  'sanktion',
  'geldbuße',
  'geldbusse',
  'bußgeld',
  'bussgeld',
  'delegierte rechtsakt',
  'durchführungsrechtsakt',
  'durchfuehrungsrechtsakt',
  'inkrafttreten',
  'übergangs',
  'uebergangs',
  'änderung der',
  'aenderung der',
  'aufsichtsbefugnis',
  'ausübung der befugnis',
  'penalt',
  'sanction',
  'delegated act',
  'implementing act',
  'entry into force',
  'transitional',
  'amendment',
  'powers of',
  'supervisory powers',
];

export type Applicability = { applicable: boolean; reason: string };

export function assessApplicability(req: Requirement): Applicability {
  const area = label(CATEGORY_LABELS, req.category);

  if (META_CATEGORIES.has(req.category)) {
    return {
      applicable: false,
      reason: `Meta-regulatorisch (Kategorie „${area}") — keine Pflicht für eine ICT-Risikomanagement-Policy.`,
    };
  }

  // Authority-only obligations belong to the regulator, not the financial entity.
  if (req.audience.length > 0 && req.audience.every((a) => a === 'authority')) {
    return {
      applicable: false,
      reason: 'Adressat ist die Aufsichtsbehörde, nicht das Finanzunternehmen.',
    };
  }

  const haystack = `${req.title} ${req.article}`.toLowerCase();
  const phrase = META_PHRASES.find((p) => haystack.includes(p));
  if (phrase) {
    return { applicable: false, reason: `Meta-regulatorische Bestimmung („${phrase}").` };
  }

  if (req.relevanceForFinancialSector === 'low') {
    return { applicable: false, reason: 'Geringe Relevanz für den Finanzsektor.' };
  }

  return { applicable: true, reason: `Pflicht mit Bezug zur ICT-Risikomanagement-Policy (${area}).` };
}

// ─────────────────────────── Step 3: Evidence ───────────────────────────

function de(primary: string | undefined, fallback: string): string {
  const v = (primary ?? '').trim();
  return v.length > 0 ? v : fallback;
}

/** Distinct concept keywords expected in the policy for this requirement.
 * Exported for the semantic pass, which reuses them to shortlist the policy
 * chunks worth showing the model for a given requirement. */
export function conceptKeywords(req: Requirement): string[] {
  const title = de(req.titleDe, req.title).toLowerCase();
  const fromTitle = title.split(/[^a-zäöüß0-9]+/i).filter((w) => w.length > 4);
  const fromTags = req.tags.map((t) => t.toLowerCase()).filter((t) => t.length > 3);
  return [...new Set([...fromTitle, ...fromTags])];
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.;:!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/** Nearest preceding heading (numbered or "Abschnitt/Section …"), or "". */
export function findSection(text: string, idx: number): string {
  if (idx < 0) return '';
  const lines = text.slice(0, idx).split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.length < 90 && /^\d+(\.\d+)*[.)]?\s+\S/.test(line)) return line;
    if (line.length < 90 && /^(section|abschnitt|kapitel|teil|chapter|artikel)\b/i.test(line)) return line;
  }
  return '';
}

export type Evidence = {
  positives: string[];
  negative?: string;
  section: string;
  /** Fraction of concept keywords found in the policy, 0..1. */
  ratio: number;
  matchedKeywords: number;
  totalKeywords: number;
};

const NO_EVIDENCE = 'No relevant evidence found.';

export function extractEvidence(policyText: string, req: Requirement): Evidence {
  const keywords = conceptKeywords(req);
  const lower = policyText.toLowerCase();
  const matched = keywords.filter((k) => lower.includes(k));
  const ratio = keywords.length > 0 ? matched.length / keywords.length : 0;

  const positives: string[] = [];
  if (matched.length > 0) {
    for (const sentence of splitSentences(policyText)) {
      const sl = sentence.toLowerCase();
      if (matched.some((k) => sl.includes(k))) {
        positives.push(sentence.length > 320 ? `${sentence.slice(0, 317)}…` : sentence);
        if (positives.length >= 2) break;
      }
    }
  }

  const section = matched.length > 0 ? findSection(policyText, lower.indexOf(matched[0])) : '';

  return {
    positives,
    negative: positives.length === 0 ? NO_EVIDENCE : undefined,
    section,
    ratio,
    matchedKeywords: matched.length,
    totalKeywords: keywords.length,
  };
}

// ─────────────────────────── Step 2 + 4 + 6: Coverage ───────────────────────────

export type CoverageStatus = 'covered' | 'partial' | 'missing';
export type Coverage = { status: CoverageStatus; confidence: number; reason: string };

const COVERED_RATIO = 0.6;
const PARTIAL_MIN_RATIO = 0.15;
/** A partial gap needs at least this many distinct concept keywords present. */
const MIN_PARTIAL_KEYWORDS = 2;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function snippet(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Classify coverage of an applicable requirement and explain WHY. Confidence is
 * high when the policy clearly addresses (or clearly omits with strong topical
 * signal) the requirement, and low when there is little evidence either way.
 */
export function assessCoverage(req: Requirement, ev: Evidence): Coverage {
  const ref = `${regulationShortName(req.regulation)} ${req.article}`.trim();
  const title = de(req.titleDe, req.title);
  const area = label(CATEGORY_LABELS, req.category);
  const summary = snippet(de(req.summaryDe, req.summary));
  const pct = `${Math.round(ev.ratio * 100)}%`;

  if (ev.totalKeywords === 0) {
    return {
      status: 'missing',
      confidence: 0.4,
      reason: `Für „${title}" konnten keine bewertbaren Konzepte abgeleitet werden (${ref}).`,
    };
  }

  if (ev.ratio >= COVERED_RATIO) {
    return {
      status: 'covered',
      confidence: round2(0.8 + 0.15 * Math.min(1, ev.ratio)),
      reason: `Die Policy adressiert „${title}" umfassend (${pct} der erwarteten Konzepte belegt, ${ref}).`,
    };
  }

  // Partial requires real topical evidence — at least two distinct concept
  // keywords AND a supporting sentence — so incidental single-word vocabulary
  // overlap (the main false-positive source) is NOT promoted to a gap.
  if (ev.ratio >= PARTIAL_MIN_RATIO && ev.matchedKeywords >= MIN_PARTIAL_KEYWORDS && ev.positives.length > 0) {
    const span = (ev.ratio - PARTIAL_MIN_RATIO) / (COVERED_RATIO - PARTIAL_MIN_RATIO);
    const confidence = round2(
      Math.min(0.92, Math.max(0.5, 0.6 + 0.06 * ev.matchedKeywords + 0.1 * Math.min(1, Math.max(0, span)))),
    );
    return {
      status: 'partial',
      confidence,
      reason:
        `Die Policy adressiert den Bereich „${area}" („${title}"), definiert die spezifische ` +
        `Anforderung gemäß ${ref} jedoch nicht vollständig. Erwartet: ${summary}`,
    };
  }

  // Little or only incidental evidence → likely missing, but low confidence (it
  // may simply be out of scope for this policy), so it won't auto-export.
  return {
    status: 'missing',
    confidence: round2(0.4 + 0.2 * ev.ratio),
    reason:
      `Im Dokument wurde kein hinreichender Nachweis für „${title}" gemäß ${ref} gefunden ` +
      `(${pct} der erwarteten Konzepte belegt).`,
  };
}

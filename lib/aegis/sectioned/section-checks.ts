import type { PlanSection, PlanVocab } from './plan';

/**
 * Deterministic per-section quality checks (epic PR 2). All three checks are
 * pure functions over already-generated section text — no model in the loop:
 *
 *   - duplication: character-trigram overlap against every finished section;
 *     above `AEGIS_DUP_TRIGRAM_THRESHOLD` the section repeats content another
 *     section owns.
 *   - scope: a section that prominently treats a `coversNot` topic (heading or
 *     repeated mentions) violates its plan scope contract.
 *   - contradiction: bounded heuristic — sentences from different sections
 *     that anchor on the same vocab term but disagree on modality
 *     (muss/verpflichtend vs. optional/kann) or negate each other.
 *
 * Findings feed ONE targeted repair pass inside the existing F9 repair budget
 * and are recorded in the section audit; they never surface to the user as
 * errors (iron rule). The assembler additionally drops verbatim-duplicate
 * blocks deterministically, so even an unrepaired duplicate never ships twice.
 */

export const DUP_TRIGRAM_DEFAULT = 0.35;

export function dupTrigramThreshold(): number {
  const raw = process.env.AEGIS_DUP_TRIGRAM_THRESHOLD;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DUP_TRIGRAM_DEFAULT;
}

// ───────────────────────── Trigram duplication ─────────────────────────

/** Normalize for robust overlap: lowercase, collapse whitespace, strip markdown noise. */
function normalizeForTrigrams(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[r-[a-z0-9-]+\]/g, ' ') // citations are expected to repeat
    .replace(/[#*_`>|.,;:!?()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * WORD trigrams (3-word shingles), not character trigrams: German prose shares
 * so many character sequences that unrelated sections would overlap; identical
 * 3-word runs are a real verbatim-repetition signal.
 */
export function trigramSet(text: string): Set<string> {
  const words = normalizeForTrigrams(text).split(' ').filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

/**
 * Overlap of the CURRENT section's shingles that a prior section already
 * shipped — duplication means "this section repeats existing content", so the
 * ratio is measured against `current`, never the smaller set.
 */
export function trigramOverlap(current: Set<string>, prior: Set<string>): number {
  if (current.size === 0 || prior.size === 0) return 0;
  let hit = 0;
  for (const g of current) if (prior.has(g)) hit++;
  return hit / current.size;
}

export type DuplicationFinding = {
  withIndex: number;
  withTitle: string;
  ratio: number;
};

export function checkDuplication(
  currentText: string,
  priors: Array<{ index: number; title: string; trigrams: Set<string> }>,
  threshold = dupTrigramThreshold(),
): DuplicationFinding[] {
  const current = trigramSet(currentText);
  const findings: DuplicationFinding[] = [];
  for (const prior of priors) {
    const ratio = trigramOverlap(current, prior.trigrams);
    if (ratio >= threshold) {
      findings.push({ withIndex: prior.index, withTitle: prior.title, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return findings;
}

// ───────────────────────── Scope adherence ─────────────────────────

export type ScopeFinding = {
  keyword: string;
  /** 'heading' = a coversNot topic got its own heading; 'repeated' = >= 3 body mentions. */
  kind: 'heading' | 'repeated';
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkScope(text: string, section: Pick<PlanSection, 'coversNot'>): ScopeFinding[] {
  const findings: ScopeFinding[] = [];
  const lower = text.toLowerCase();
  for (const keyword of section.coversNot) {
    const norm = keyword.toLowerCase().trim();
    if (norm.length < 3) continue;
    const kw = escapeRegExp(norm);
    // A heading that leads with the out-of-scope topic — strongest violation.
    const heading = new RegExp(`^#{2,4}[^\\n]*${kw}`, 'im');
    if (heading.test(text)) {
      findings.push({ keyword, kind: 'heading' });
      continue;
    }
    const mentions = lower.match(new RegExp(kw, 'g'))?.length ?? 0;
    if (mentions >= 3) findings.push({ keyword, kind: 'repeated' });
  }
  return findings;
}

// ───────────────────────── Contradiction heuristic ─────────────────────────

export type ContradictionFinding = {
  term: string;
  withIndex: number;
  withTitle: string;
  /** The two clashing sentence fragments (trimmed for the audit log). */
  current: string;
  prior: string;
};

const OBLIGATION_RE = /\b(muss|müssen|verpflichtend|zwingend|erforderlich|ist vorgeschrieben|shall|must|mandatory|required)\b/i;
const OPTIONAL_RE = /\b(kann|können|optional|freiwillig|empfohlen|nicht erforderlich|nicht verpflichtend|may|can|voluntary|recommended|not required)\b/i;
const NEGATED_OBLIGATION_RE = /\b(nicht|keine?|kein)\s+(verpflichtend|zwingend|erforderlich|vorgeschrieben)\b/i;

function sentencesWithTerm(text: string, term: string): string[] {
  const kw = escapeRegExp(term.toLowerCase());
  const re = new RegExp(kw);
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && re.test(s.toLowerCase()));
}

/** Modality of a sentence: 'obligation' | 'optional' | null (no clear signal). */
function modality(sentence: string): 'obligation' | 'optional' | null {
  if (NEGATED_OBLIGATION_RE.test(sentence)) return 'optional';
  const ob = OBLIGATION_RE.test(sentence);
  const op = OPTIONAL_RE.test(sentence);
  if (ob && !op) return 'obligation';
  if (op && !ob) return 'optional';
  return null; // both or neither → ambiguous, no finding
}

/**
 * Cross-section modality clash on shared vocabulary terms. Deliberately
 * conservative: only sentences with an unambiguous modality signal on the SAME
 * vocab term in DIFFERENT sections can clash, so false positives stay rare.
 * This is a heuristic tripwire for the audit + repair feedback, not a proof.
 */
export function checkContradiction(
  currentText: string,
  currentIndex: number,
  priors: Array<{ index: number; title: string; text: string }>,
  vocab: Pick<PlanVocab, 'entities' | 'terminology'>,
): ContradictionFinding[] {
  const terms = [...vocab.entities, ...vocab.terminology]
    .map((t) => t.split(',')[0].trim())
    .filter((t) => t.length >= 4)
    .slice(0, 24);
  const findings: ContradictionFinding[] = [];
  for (const term of terms) {
    const currentSentences = sentencesWithTerm(currentText, term);
    if (currentSentences.length === 0) continue;
    const currentModes = currentSentences
      .map((s) => ({ s, m: modality(s) }))
      .filter((x): x is { s: string; m: 'obligation' | 'optional' } => x.m !== null);
    if (currentModes.length === 0) continue;
    for (const prior of priors) {
      if (prior.index === currentIndex) continue;
      for (const ps of sentencesWithTerm(prior.text, term)) {
        const pm = modality(ps);
        if (!pm) continue;
        const clash = currentModes.find((c) => c.m !== pm);
        if (clash) {
          findings.push({
            term,
            withIndex: prior.index,
            withTitle: prior.title,
            current: clash.s.slice(0, 200),
            prior: ps.slice(0, 200),
          });
          break; // one finding per term/prior pair is enough for the audit
        }
      }
    }
  }
  return findings;
}

// ───────────────────────── Aggregate entry point ─────────────────────────

export type SectionCheckFindings = {
  duplication: DuplicationFinding[];
  scope: ScopeFinding[];
  contradiction: ContradictionFinding[];
};

export function hasBlockingFindings(f: SectionCheckFindings): boolean {
  // Duplication and scope violations are repairable defects; contradictions
  // are audit-only (the heuristic is too weak to justify burning a repair).
  return f.duplication.length > 0 || f.scope.length > 0;
}

export function runSectionChecks(args: {
  text: string;
  section: PlanSection;
  sectionIndex: number;
  priors: Array<{ index: number; title: string; text: string }>;
  vocab: PlanVocab;
}): SectionCheckFindings {
  const priorTrigrams = args.priors.map((p) => ({
    index: p.index,
    title: p.title,
    trigrams: trigramSet(p.text),
  }));
  return {
    duplication: checkDuplication(args.text, priorTrigrams),
    scope: checkScope(args.text, args.section),
    contradiction: checkContradiction(args.text, args.sectionIndex, args.priors, args.vocab),
  };
}

/** German repair feedback for a failed check run — fed to the tool-free repair pass. */
export function checkRepairFeedback(f: SectionCheckFindings): string {
  const parts: string[] = [];
  if (f.duplication.length) {
    parts.push(
      `Der Abschnitt wiederholt Inhalte aus: ${f.duplication
        .map((d) => `"${d.withTitle}" (Überlappung ${Math.round(d.ratio * 100)} %)`)
        .join(', ')}. Entferne die Wiederholungen — dieser Abschnitt behandelt nur seine eigenen Themen.`,
    );
  }
  if (f.scope.length) {
    parts.push(
      `Folgende Themen gehören laut Gliederung NICHT in diesen Abschnitt: ${f.scope
        .map((s) => `"${s.keyword}"`)
        .join(', ')}. Kürze sie auf höchstens einen Verweis auf den zuständigen Abschnitt.`,
    );
  }
  return parts.join('\n');
}

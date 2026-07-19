import { intEnv } from '../env';
import { estimateTokens } from '../memory-seed';
import { AegisMode, AegisModeInput, MODEL_IDS } from '../types';
import type { CallModelFn } from '../router';
import type { ClaudeUsage } from '../context/cost';

/**
 * Deliverable triage — decides whether a request runs through the existing
 * single-pass pipeline (UNCHANGED — the regression contract) or the sectioned
 * pipeline (plan pass → sequential sections → assembler).
 *
 * Two independent signal sources, combined by `resolveStrategy`:
 *   1. Deterministic heuristics (pure, zero-latency): numbered-section count,
 *      input size, explicit catalogue/report keywords.
 *   2. One Haiku triage call (~300 ms, invisible) that normalises the intent
 *      into a `deliverableKind` regardless of phrasing, language or typos.
 *      It EXTENDS the existing intent classification (mode + complexity) so
 *      the wired pipeline needs a single Haiku round-trip, not two.
 *
 * Fail-open: if the Haiku call errors or returns garbage, the deterministic
 * heuristics alone decide — a triage failure must never surface to the user
 * or block a turn.
 */

export type DeliverableStrategy = 'SINGLE_PASS' | 'SECTIONED';
export type DeliverableKind = 'question' | 'assessment' | 'report' | 'catalogue';

export type TriageResult = {
  /** Normalised intent mode (advisory — `req.mode` stays authoritative for single-pass). */
  mode: AegisMode;
  /** 0.0 trivial … 1.0 multi-step cross-regulation reasoning (drives Haiku↔Sonnet). */
  complexity: number;
  deliverableKind: DeliverableKind;
  deliverableStrategy: DeliverableStrategy;
  /** Which signals fired ('sections' | 'input_tokens' | 'keywords' | 'kind') — telemetry only. */
  signals: string[];
};

export const FALLBACK_TRIAGE: TriageResult = {
  mode: 'CONVERSATIONAL',
  complexity: 0.5,
  deliverableKind: 'question',
  deliverableStrategy: 'SINGLE_PASS',
  signals: [],
};

// ───────────────────────── Deterministic heuristics ─────────────────────────

/**
 * Numbered top-level list lines ("1. Open-Source…", "3) Security"), counted on
 * DISTINCT leading numbers so a nested re-numbering ("1." appearing twice in
 * sub-lists) doesn't inflate the count.
 */
const NUMBERED_LINE = /^\s{0,3}(\d{1,2})[.)]\s+\S/gm;

/** Explicit deliverable asks (DE + EN). Word-bounded so "reporting"/"Berichterstattung" don't fire. */
const DELIVERABLE_KEYWORDS =
  /\b(katalog|katalogs|catalogue|catalog|bericht|berichts|report|gutachten|compliance[- ]?katalog)\b/i;

export function countNumberedSections(message: string): number {
  const seen = new Set<string>();
  for (const m of message.matchAll(NUMBERED_LINE)) seen.add(m[1]);
  return seen.size;
}

/** Pure heuristic signals — exported for tests and for the fail-open path. */
export function heuristicSignals(message: string): string[] {
  const signals: string[] = [];
  if (countNumberedSections(message) >= intEnv('AEGIS_SECTIONED_MIN_SECTIONS', 5)) {
    signals.push('sections');
  }
  if (estimateTokens(message, 'de') > intEnv('AEGIS_SECTIONED_INPUT_TOKENS', 2000)) {
    signals.push('input_tokens');
  }
  if (DELIVERABLE_KEYWORDS.test(message)) {
    signals.push('keywords');
  }
  return signals;
}

/**
 * Combine both signal sources. SECTIONED when any deterministic signal fired OR
 * the normalised intent is a report/catalogue deliverable. `question` and
 * `assessment` alone never section — a plain assessment is what the existing
 * ASSESS single-pass mode is for.
 */
export function resolveStrategy(
  signals: string[],
  kind: DeliverableKind,
): { deliverableStrategy: DeliverableStrategy; signals: string[] } {
  const all = [...signals];
  if ((kind === 'report' || kind === 'catalogue') && !all.includes('kind')) {
    all.push('kind');
  }
  return {
    deliverableStrategy: all.length > 0 ? 'SECTIONED' : 'SINGLE_PASS',
    signals: all,
  };
}

// ───────────────────────── Haiku triage call ─────────────────────────

const TRIAGE_SYSTEM = `You are an intent classifier for the RegCompass AEGIS agent.

Classify the user message into exactly one mode:
- ASSESS: user wants to assess an AI system against regulations (mentions a use case, sector, jurisdiction, attributes).
- GAP_ANALYZE: user supplies a policy document or asks for gap analysis.
- CONVERSATIONAL: any other free-form question about regulations.

Also rate complexity from 0.0 to 1.0:
- 0.0–0.3: trivial factual lookup ("What is DORA?", "Which articles cover credit scoring?").
- 0.4–0.6: standard explanation requiring 1–2 KB lookups.
- 0.7–1.0: multi-step cross-regulation reasoning or ambiguous scope.

Also normalise the requested deliverable into exactly one kind, regardless of
phrasing, language (German/English) or typos:
- "question": an answer/explanation, however long.
- "assessment": a structured assessment of ONE system/use case.
- "report": a multi-section report, analysis document, Gutachten or expert opinion.
- "catalogue": a structured catalogue/register/matrix of controls, requirements or measures (a report that ENDS with a catalogue is a "catalogue").

Return ONLY a JSON object on a single line, no other text:
{"mode":"<MODE>","complexity":<NUMBER>,"deliverableKind":"<KIND>"}`;

const KINDS: ReadonlySet<string> = new Set(['question', 'assessment', 'report', 'catalogue']);

/**
 * Full triage: deterministic heuristics + one Haiku call. Replaces
 * `classifyIntent` 1:1 for the wired pipeline (same mode/complexity semantics,
 * same fallback behaviour) and adds the deliverable normalisation on top.
 */
export async function classifyTriage(
  message: string,
  callModel: CallModelFn,
  onUsage?: (usage: ClaudeUsage) => void,
): Promise<TriageResult> {
  const signals = heuristicSignals(message);
  const heuristicOnly: TriageResult = {
    ...FALLBACK_TRIAGE,
    ...resolveStrategy(signals, FALLBACK_TRIAGE.deliverableKind),
  };

  try {
    const { text, usage } = await callModel({
      model: MODEL_IDS.haiku,
      prompt: `${TRIAGE_SYSTEM}\n\nUser message:\n${message}`,
      maxTokens: 120,
    });
    if (usage) onUsage?.(usage);

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return heuristicOnly;

    const raw = JSON.parse(match[0]) as {
      mode?: unknown;
      complexity?: unknown;
      deliverableKind?: unknown;
    };
    const mode = AegisModeInput.parse(raw.mode);
    const complexity = Number(raw.complexity);
    if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) {
      return heuristicOnly;
    }
    const kind: DeliverableKind = KINDS.has(String(raw.deliverableKind))
      ? (raw.deliverableKind as DeliverableKind)
      : 'question';

    return {
      mode,
      complexity,
      deliverableKind: kind,
      ...resolveStrategy(signals, kind),
    };
  } catch {
    return heuristicOnly;
  }
}

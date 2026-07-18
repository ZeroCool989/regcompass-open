import { callStructured } from './client';
import { MODEL_IDS } from './types';
import type { ClaudeUsage } from './context/cost';
import type { Requirement } from '@/lib/kb/types';
import { conceptKeywords, type Coverage } from './coverage';
import { deriveSeverity, severityRank } from './gap-finding';

/**
 * Semantic coverage pass (review 2026-07, DOC-5). The deterministic keyword
 * engine remains the grounding layer — this pass adds what keywords cannot do:
 * semantic reading of the policy, weak-provision judgement, and contradiction
 * detection. Its verdicts NEVER stand alone:
 *
 *  - every verdict must carry a verbatim quote from the policy text; a quote
 *    that does not literally occur in the document voids the verdict
 *    (citation firewall — the model cannot smuggle in fabricated evidence);
 *  - the merge rules in analyze_document only let a verified semantic verdict
 *    ADJUST the deterministic result (downgrade covered → partial, upgrade
 *    missing → partial, veto a low-confidence gap) — severity always stays the
 *    deterministic derivation.
 *
 * Cost is bounded: at most AEGIS_SEMANTIC_MAX_REQS requirements (default 40,
 * severity-priority), batched requests, Haiku only.
 */

export type SemanticVerdictKind = 'covered' | 'partial' | 'missing' | 'contradiction';

export type SemanticVerdict = {
  requirementId: string;
  verdict: SemanticVerdictKind;
  /** Verbatim quote from the policy supporting the verdict ('' allowed only for missing). */
  quote: string;
  /** Short German rationale. */
  note: string;
};

export type SemanticPassResult = {
  /** Verified verdicts by requirement id (firewall already applied). */
  verdicts: Map<string, SemanticVerdict>;
  /** Number of model calls spent. */
  calls: number;
  /** Requirements sent to the model. */
  candidates: number;
  /** Verdicts voided because their quote was not found in the policy. */
  quotesRejected: number;
};

const CHUNK_SIZE = 12_000;
const CHUNK_OVERLAP = 600;
const REQS_PER_CALL = 8;
const EXCERPT_CHARS = 2_600;
const NOTE_MAX = 300;

function maxSemanticReqs(): number {
  const v = Number(process.env.AEGIS_SEMANTIC_MAX_REQS);
  return Number.isFinite(v) && v >= 0 ? v : 40;
}

/** Semantic pass on/off switch (default ON; AEGIS_SEMANTIC_PASS=0 disables). */
export function semanticPassEnabled(): boolean {
  return process.env.AEGIS_SEMANTIC_PASS !== '0';
}

export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

/** Whitespace-insensitive containment check for the quote firewall. */
export function quoteOccursIn(quote: string, policyText: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(quote);
  if (q.length < 15) return false; // too short to be meaningful evidence
  return norm(policyText).includes(q);
}

/** Pick the chunks most likely to contain evidence for this requirement. */
function bestChunks(chunks: string[], req: Requirement, take = 2): string[] {
  const keywords = conceptKeywords(req);
  const scored = chunks.map((c, i) => {
    const lower = c.toLowerCase();
    const hits = keywords.filter((k) => lower.includes(k)).length;
    return { i, hits };
  });
  scored.sort((a, b) => b.hits - a.hits || a.i - b.i);
  return scored.slice(0, take).map((s) => chunks[s.i].slice(0, EXCERPT_CHARS));
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirementId: { type: 'string' },
          verdict: { type: 'string', enum: ['covered', 'partial', 'missing', 'contradiction'] },
          quote: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['requirementId', 'verdict', 'quote', 'note'],
      },
    },
  },
  required: ['verdicts'],
} as const;

const SYSTEM = `Du bist ein präziser Prüfassistent für Richtlinien-Dokumente im Finanzsektor.
Du erhältst regulatorische Anforderungen und Auszüge aus einer Policy. Beurteile pro Anforderung, ob die Policy sie inhaltlich abdeckt (covered), nur teilweise/schwach adressiert (partial), nicht adressiert (missing) oder ihr WIDERSPRICHT (contradiction — z. B. die Policy nennt eine andere Frist, einen engeren Geltungsbereich oder erlaubt, was die Anforderung verbietet).
Regeln (verbindlich):
- "quote" MUSS ein wörtliches Zitat aus den gezeigten Policy-Auszügen sein (kein Paraphrasieren). Nur für "missing" darf quote leer sein.
- Beurteile NUR anhand der gezeigten Auszüge. Wenn die Auszüge keine Aussage erlauben, antworte "missing" mit leerem quote.
- "note": maximal zwei kurze deutsche Sätze, sachlich.
- Erfinde nichts. Keine Anforderungen bewerten, die nicht gelistet sind.`;

function buildPrompt(batch: { req: Requirement; excerpts: string[] }[]): string {
  const parts = batch.map(({ req, excerpts }) => {
    const summary = (req.summaryDe?.trim() || req.summary).slice(0, 500);
    return `### ${req.id} — ${req.titleDe?.trim() || req.title}\nAnforderung: ${summary}\n\nPolicy-Auszüge:\n${excerpts.map((e, i) => `[Auszug ${i + 1}]\n${e}`).join('\n\n')}`;
  });
  return `Bewerte die folgenden ${batch.length} Anforderungen gegen die jeweiligen Policy-Auszüge.\n\n${parts.join('\n\n---\n\n')}`;
}

export type SemanticPassInput = {
  policyText: string;
  /** Applicable requirements with their deterministic coverage verdicts. */
  candidates: { req: Requirement; det: Coverage }[];
  onUsage?: (model: string, usage: ClaudeUsage) => void;
};

/**
 * Run the bounded semantic pass. Selection: requirements whose deterministic
 * verdict is uncertain (confidence < 0.85) or 'covered' (weak-provision +
 * contradiction check), severity-prioritized, capped.
 */
export async function runSemanticPass(input: SemanticPassInput): Promise<SemanticPassResult> {
  const empty: SemanticPassResult = { verdicts: new Map(), calls: 0, candidates: 0, quotesRejected: 0 };
  if (!semanticPassEnabled()) return empty;

  const cap = maxSemanticReqs();
  if (cap === 0) return empty;

  const selected = input.candidates
    .filter(({ det }) => det.confidence < 0.85 || det.status === 'covered')
    .sort((a, b) => severityRank(deriveSeverity(a.req)) - severityRank(deriveSeverity(b.req)))
    .slice(0, cap);
  if (selected.length === 0) return empty;

  const chunks = chunkText(input.policyText);
  const verdicts = new Map<string, SemanticVerdict>();
  let calls = 0;
  let quotesRejected = 0;

  for (let i = 0; i < selected.length; i += REQS_PER_CALL) {
    const batch = selected.slice(i, i + REQS_PER_CALL).map(({ req }) => ({
      req,
      excerpts: bestChunks(chunks, req),
    }));
    const batchIds = new Set(batch.map((b) => b.req.id));

    let value: { verdicts: SemanticVerdict[] };
    try {
      const res = await callStructured<{ verdicts: SemanticVerdict[] }>({
        model: MODEL_IDS.haiku,
        system: SYSTEM,
        prompt: buildPrompt(batch),
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 2048,
      });
      calls++;
      input.onUsage?.(MODEL_IDS.haiku, res.usage);
      value = res.value;
    } catch (err) {
      // The semantic pass is an enhancement — a model failure must never fail
      // the analysis. Deterministic results stand; the pass reports fewer
      // candidates via `calls`.
      console.error('[aegis/semantic] batch failed:', err instanceof Error ? err.message : err);
      continue;
    }

    for (const v of value.verdicts ?? []) {
      if (!batchIds.has(v.requirementId)) continue; // not asked → dropped
      const note = (v.note ?? '').slice(0, NOTE_MAX);
      const quote = (v.quote ?? '').trim();
      if (v.verdict === 'missing' && quote.length === 0) {
        verdicts.set(v.requirementId, { ...v, note, quote: '' });
        continue;
      }
      // Citation firewall: evidence must literally occur in the policy.
      if (!quoteOccursIn(quote, input.policyText)) {
        quotesRejected++;
        continue;
      }
      verdicts.set(v.requirementId, { ...v, note, quote });
    }
  }

  return { verdicts, calls, candidates: selected.length, quotesRejected };
}

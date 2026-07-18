/**
 * Structured conversation digest — the Aegis-native context compaction (Phase 2).
 *
 * Per Anthropic's guidance, compaction "summarizes [context] and reinitializes
 * a new context window with the summary", preserving "architectural decisions,
 * unresolved bugs, and implementation details". We produce a STRUCTURED digest
 * rather than prose so nothing load-bearing is lost, and — critically for a
 * compliance tool — citation IDs (`[R-…]`) are preserved verbatim so the run
 * stays grounded and the verify step keeps working.
 *
 * The transcript in Postgres remains authoritative; the digest is a derived
 * replay view (reversible). Pure helpers here are unit-tested; the model call
 * is injected so it's testable without a key.
 */

import { callStructured } from './client';
import { MODEL_IDS } from './types';
import { estimateTokens, type SeedMessage } from './memory-seed';
import { MemoryConfig } from './memory-config';

/** Canonical Aegis citation token, e.g. [R-FINMA-0824] — matches the renderer. */
const CITATION_RE = /\[R-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/g;

/**
 * Hard ceiling on the transcript we'll feed the digest model (from the central
 * MemoryConfig). Above this we refuse with a clear error instead of producing a
 * half-summary. Re-exported as a named constant for backwards compatibility.
 */
export const MAX_DIGEST_INPUT_TOKENS = MemoryConfig.digestMaxInputTokens;

/** Thrown when the transcript is too large to compact in one pass. */
export class DigestInputTooLargeError extends Error {
  constructor(public readonly approxTokens: number) {
    super(`Transcript too large to compact (${approxTokens} tokens > ${MAX_DIGEST_INPUT_TOKENS}).`);
    this.name = 'DigestInputTooLargeError';
  }
}

export interface ConversationDigest {
  /** Decisions the user made (kept verbatim-ish). */
  decisions: string[];
  /** Tasks still open / in-flight at compaction time. */
  openTasks: string[];
  /** Established findings; citation IDs like [R-XXXX-YYY] preserved verbatim. */
  conclusions: string[];
  /** Interaction-style patterns observed — candidates for personalization,
   *  NEVER auto-saved (Phase 3+). */
  preferencesObserved: string[];
}

export interface DigestMessage {
  role: 'user' | 'assistant';
  content: string;
  seq: number;
}

/** JSON Schema for structured output (simple types only — no unsupported constraints). */
export const DIGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisions: { type: 'array', items: { type: 'string' } },
    openTasks: { type: 'array', items: { type: 'string' } },
    conclusions: { type: 'array', items: { type: 'string' } },
    preferencesObserved: { type: 'array', items: { type: 'string' } },
  },
  required: ['decisions', 'openTasks', 'conclusions', 'preferencesObserved'],
};

const DIGEST_SYSTEM =
  'Du verdichtest einen AEGIS-Compliance-Dialog in eine strukturierte ' +
  'Zusammenfassung. Bewahre Bedeutung, entferne Wiederholungen. REGELN: ' +
  '(1) Zitations-IDs in eckigen Klammern wie [R-FINMA-0824] IMMER wörtlich ' +
  'erhalten. (2) Keine erfundenen Fakten — nur was im Dialog steht. ' +
  '(3) Entscheidungen, offene Aufgaben und gesicherte Schlussfolgerungen ' +
  'vollständig bewahren. (4) preferencesObserved: nur Hinweise auf den ' +
  'bevorzugten Antwortstil des Nutzers (z. B. „will zuerst die Umsetzung"), ' +
  'niemals regulatorische oder geschäftliche Inhalte.';

/** Render the transcript compactly for the digest prompt. */
export function buildDigestInput(messages: DigestMessage[]): string {
  return messages
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((m) => `${m.role === 'user' ? 'NUTZER' : 'AEGIS'}: ${m.content}`)
    .join('\n\n');
}

/** Render a digest into the assistant seed text (citations preserved). */
export function renderDigestText(d: ConversationDigest): string {
  const section = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  return [
    '[Zusammenfassung des bisherigen Gesprächs]',
    section('Entscheidungen', d.decisions),
    section('Offene Aufgaben', d.openTasks),
    section('Schlussfolgerungen', d.conclusions),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A digest becomes one synthetic user/assistant pair at the head of the seed. */
export function digestToSeed(d: ConversationDigest): SeedMessage[] {
  return [
    { role: 'user', content: 'Fasse den bisherigen Gesprächskontext zusammen.' },
    { role: 'assistant', content: renderDigestText(d) },
  ];
}

/** Prepend the digest pair to the post-digest seed. Pure. */
export function applyDigestToSeed(
  d: ConversationDigest,
  postDigestSeed: SeedMessage[],
): SeedMessage[] {
  return [...digestToSeed(d), ...postDigestSeed];
}

function normalize(raw: Partial<ConversationDigest> | null | undefined): ConversationDigest {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    decisions: arr(raw?.decisions),
    openTasks: arr(raw?.openTasks),
    conclusions: arr(raw?.conclusions),
    preferencesObserved: arr(raw?.preferencesObserved),
  };
}

/** All distinct citation tokens (e.g. [R-FINMA-0824]) appearing in `text`. */
export function extractCitations(text: string): Set<string> {
  return new Set(text.match(CITATION_RE) ?? []);
}

function sanitizeField(items: string[], allowed: Set<string>): string[] {
  return items
    .map((s) =>
      s
        .replace(CITATION_RE, (tok) => (allowed.has(tok) ? tok : ''))
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;:])/g, '$1')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/**
 * Citation firewall: strip any [R-…] from the digest that is NOT present in the
 * source transcript. A fabricated citation is worse than a dropped one — the
 * digest is injected as an accepted prior turn and bypasses the verify step, so
 * a hallucinated citation would become fake grounding. Returns the cleaned
 * digest and the list of fabricated tokens removed (for logging/metrics).
 */
export function enforceCitations(
  d: ConversationDigest,
  sourceText: string,
): { digest: ConversationDigest; fabricated: string[] } {
  const allowed = extractCitations(sourceText);
  const fabricated = new Set<string>();
  for (const field of [d.decisions, d.openTasks, d.conclusions, d.preferencesObserved]) {
    for (const s of field) {
      for (const tok of s.match(CITATION_RE) ?? []) {
        if (!allowed.has(tok)) fabricated.add(tok);
      }
    }
  }
  const digest: ConversationDigest = {
    decisions: sanitizeField(d.decisions, allowed),
    openTasks: sanitizeField(d.openTasks, allowed),
    conclusions: sanitizeField(d.conclusions, allowed),
    preferencesObserved: sanitizeField(d.preferencesObserved, allowed),
  };
  return { digest, fabricated: [...fabricated] };
}

/** Objective compaction-fidelity metrics for a digest vs. its source. */
export function citationMetrics(d: ConversationDigest, sourceText: string) {
  const source = extractCitations(sourceText);
  const digestText = [
    ...d.decisions,
    ...d.openTasks,
    ...d.conclusions,
    ...d.preferencesObserved,
  ].join(' ');
  const inDigest = extractCitations(digestText);
  const fabricated = [...inDigest].filter((c) => !source.has(c));
  const retained = [...source].filter((c) => inDigest.has(c));
  const missing = [...source].filter((c) => !inDigest.has(c));
  return {
    sourceCount: source.size,
    digestCount: inDigest.size,
    fabricated,
    missing,
    retention: source.size === 0 ? 1 : retained.length / source.size,
    fabricationRate: inDigest.size === 0 ? 0 : fabricated.length / inDigest.size,
  };
}

/**
 * Generate a digest from the transcript. The model call is injected (defaults
 * to the real structured call on Haiku) so callers/tests can stub it.
 *
 * Guards: refuses an oversized transcript (`DigestInputTooLargeError`) before
 * spending a call; enforces the citation firewall on the result so the stored
 * digest can never contain a fabricated [R-…].
 */
export async function generateDigest(
  messages: DigestMessage[],
  deps: { call?: typeof callStructured } = {},
): Promise<ConversationDigest> {
  const input = buildDigestInput(messages);
  const approxTokens = estimateTokens(input, 'de');
  if (approxTokens > MAX_DIGEST_INPUT_TOKENS) {
    throw new DigestInputTooLargeError(approxTokens);
  }

  const call = deps.call ?? callStructured;
  const { value } = await call<Partial<ConversationDigest>>({
    model: MODEL_IDS.haiku,
    system: DIGEST_SYSTEM,
    prompt: input,
    schema: DIGEST_SCHEMA,
    maxTokens: 2000,
  });
  return enforceCitations(normalize(value), input).digest;
}

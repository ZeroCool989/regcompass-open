import { z } from 'zod';
import { KB } from '@/lib/kb';
import { callStructured } from './client';
import { extractCitations } from './digest';
import {
  getTranscript,
  getTranscriptForUser,
  type MemoryMessage,
} from './memory';
import {
  NO_POLICY_EXCERPT,
  regulationShortName,
  type GapFinding,
} from './gap-finding';
import { MODEL_IDS } from './types';
import type { ClaudeUsage } from './context/cost';
import {
  FILL_CONVERSATION_NOT_FOUND_DE,
  UNVERIFIED_SOURCE_NOTE_DE,
} from './statusLabels';

/**
 * Conversation-sourced findings for fill_template — the source abstraction
 * that lets assessments born purely in chat (no document upload) flow into
 * Excel templates WITHOUT weakening the provenance obligation.
 *
 * Pipeline per assistant message (sequential, conservative):
 *   1. Ownership FIRST (session or user scope, memory-layer rules) — a foreign
 *      or unknown conversation id fails with the same not-found error before
 *      ANY processing starts.
 *   2. CONVERSATIONAL messages: Haiku classification gate ("does this message
 *      contain findings at all?") — most are clarifications/explanations and
 *      are skipped. Structured modes skip the gate (their answers ARE findings).
 *   3. Sonnet extraction into a Zod-validated item list, mode-aware.
 *   4. Citation firewall (digest.ts pattern): [R-…] IDs survive only if they
 *      appear literally in the source message — never invented, never "fixed".
 *   5. Deterministic TS mapping ExtractedItem → GapFinding decides every Excel
 *      column (status, prefix, evidence, manualReview) — NOT the model.
 *
 * Rather one finding too few than one invented: any message that fails
 * classification, extraction or validation is skipped, never guessed at.
 */

// ───────────────────────── Source type ─────────────────────────

export type FillSource =
  | { kind: 'document'; documentId: string }
  | { kind: 'conversation'; conversationId: string; messageIds?: string[] };

/** Full provenance record persisted with every conversation-sourced fill run. */
export type ConversationSourceRef = {
  kind: 'conversation';
  conversationId: string;
  /** The assistant messages findings were extracted from (post-filter). */
  messageIds: string[];
  /** Mode per source message (audit: which pipeline produced the finding). */
  modeByMessage: Record<string, string>;
  /** Messages included but NOT fully verified (banner/exitReason) — their findings are marked. */
  unverifiedMessageIds: string[];
  extractedAt: string;
};

// ───────────────────────── Extraction schema ─────────────────────────

export type FindingType = 'finding' | 'gap' | 'recommendation';

const SeverityEnum = z.enum(['Low', 'Medium', 'High', 'Critical']);

/**
 * Flat item shape (not a discriminated union) so the structured-output JSON
 * schema stays simple and robust; the per-type required fields are enforced
 * here and the DETERMINISTIC mapping below branches on `findingType`.
 */
export const ExtractedItem = z
  .object({
    findingType: z.enum(['finding', 'gap', 'recommendation']),
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(2000),
    regulation: z.string().max(60).default(''),
    article: z.string().max(60).default(''),
    /** [R-…] IDs cited in the source message for THIS item (firewalled below). */
    citations: z.array(z.string().max(40)).max(10).default([]),
    /**
     * OPTIONAL by design: only present when the source message states it.
     * A missing value is filled by a DETERMINISTIC default in toGapFindings
     * (with manualReview) — the model never chooses a score (Inv 1).
     */
    severity: SeverityEnum.optional(),
    /** Extraction fidelity 0..1 — how literally the item is stated in the source. */
    confidence: z.number().min(0).max(1),
    /** finding: where/what was assessed (quote or close paraphrase). */
    sourceContext: z.string().max(600).default(''),
    /** gap: the Soll (requirement, as stated in the message). */
    requirement: z.string().max(1000).default(''),
    /** gap: the Ist (current state, as stated in the message). */
    currentState: z.string().max(1000).default(''),
    /** finding/gap: coverage status — ONLY when stated in the verified message. */
    status: z.enum(['covered', 'partial', 'missing']).optional(),
    /** recommendation: the stated rationale. */
    rationale: z.string().max(1000).default(''),
  })
  .superRefine((item, ctx) => {
    if (item.findingType === 'gap' && item.requirement.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'gap item requires the Soll (requirement).' });
    }
  });
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractionResult = z.object({ items: z.array(ExtractedItem).max(30) });
export type ExtractionResult = z.infer<typeof ExtractionResult>;

const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          findingType: { type: 'string', enum: ['finding', 'gap', 'recommendation'] },
          title: { type: 'string' },
          description: { type: 'string' },
          regulation: { type: 'string' },
          article: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] },
          confidence: { type: 'number' },
          sourceContext: { type: 'string' },
          requirement: { type: 'string' },
          currentState: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'partial', 'missing'] },
          rationale: { type: 'string' },
        },
        // severity/status deliberately NOT required — omitted when the source
        // does not state them (deterministic default + manualReview in TS).
        required: ['findingType', 'title', 'description', 'confidence'],
      },
    },
  },
  required: ['items'],
};

const CLASSIFY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: { containsFindings: { type: 'boolean' } },
  required: ['containsFindings'],
};

// ───────────────────────── Prompts (mode-aware) ─────────────────────────

const EXTRACT_SYSTEM_BASE =
  'Du extrahierst Assessment-Ergebnisse aus einer VERIFIZIERTEN AEGIS-Antwort ' +
  'in eine strukturierte Liste. REGELN: (1) NUR extrahieren, was die Antwort ' +
  'explizit feststellt — nichts ergänzen, nichts umdeuten, keine eigenen ' +
  'Einschätzungen. (2) citations: NUR [R-…]-IDs, die wörtlich in der Antwort ' +
  'stehen (ohne eckige Klammern angeben). (3) status/severity: NUR angeben, ' +
  'wenn die Antwort sie ausdrücklich aussagt; fehlt die Angabe, das Feld ' +
  'WEGLASSEN — niemals selbst einschätzen. (4) Lieber ein Item zu wenig als ' +
  'eines erfunden — Rückfragen, Erklärungen und Meta-Text sind KEINE Items.';

const MODE_INSTRUCTION: Record<string, string> = {
  ASSESS:
    'Die Antwort stammt aus dem ASSESS-Modus (strukturierte Bewertung). ' +
    'Extrahiere jede Feststellung als findingType "finding": Befund ' +
    '(description), Fundstelle/Kontext (sourceContext), Citation, Severity, ' +
    'status wie ausgesagt.',
  GAP_ANALYZE:
    'Die Antwort stammt aus dem GAP_ANALYZE-Modus. Extrahiere jede Lücke als ' +
    'findingType "gap": Anforderung/Soll (requirement, mit [R-…]-Citation), ' +
    'Ist-Zustand (currentState), Gap-Beschreibung (description), Severity, ' +
    'status ("partial" oder "missing").',
  CONVERSATIONAL:
    'Die Antwort stammt aus einem freien Gespräch. Extrahiere NUR eindeutig ' +
    'ausgesprochene Feststellungen (finding), Lücken (gap) oder Empfehlungen ' +
    '(recommendation). Eine Empfehlung ist KEIN festgestellter Mangel — ' +
    'niemals als "finding" oder "gap" klassifizieren. Erklärungen, ' +
    'Definitionen und Rückfragen ergeben KEINE Items — dann items: [].',
};

const CLASSIFY_SYSTEM =
  'Du klassifizierst eine AEGIS-Chat-Antwort: Enthält sie konkrete ' +
  'Assessment-Ergebnisse (Feststellungen, Compliance-Lücken oder ' +
  'Empfehlungen), die in ein Assessment-Register übernommen werden könnten? ' +
  'Reine Erklärungen, Definitionen, Rückfragen oder Meta-Antworten → false. ' +
  'Im Zweifel false.';

// ───────────────────────── Unverified-source detection ─────────────────────────

/**
 * Markers of content that never fully passed verification: the time-pressure
 * degradation banner (loop.ts, persisted with exitReason 'verify_degraded')
 * and the client-side timeout-draft note (#12 — today client-only, but the
 * marker check also covers any future persistence of such drafts).
 */
const UNVERIFIED_MARKERS = [
  'Verifizierung unvollständig',
  'Antwort unvollständig — nicht verifiziert',
];

export function isUnverifiedSource(m: Pick<MemoryMessage, 'exitReason' | 'content'>): boolean {
  if (m.exitReason === 'verify_degraded') return true;
  return UNVERIFIED_MARKERS.some((marker) => m.content.includes(marker));
}

// ───────────────────────── Citation firewall ─────────────────────────

const BARE_ID = /^R-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const KB_CITATION_TOKEN = /\[R-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/g;

/**
 * Keep only citations that literally appear in the source message (digest.ts
 * firewall pattern). Also strips unknown [R-…] tokens out of the free-text
 * fields so a fabricated ID can't ride along inside a description. Returns the
 * cleaned items plus the fabricated tokens (for telemetry).
 */
export function enforceItemCitations(
  items: ExtractedItem[],
  sourceText: string,
): { items: ExtractedItem[]; fabricated: string[] } {
  const allowedTokens = extractCitations(sourceText); // "[R-…]" tokens
  const allowedIds = new Set([...allowedTokens].map((t) => t.slice(1, -1)));
  const fabricated = new Set<string>();

  const cleanText = (s: string): string =>
    s
      .replace(KB_CITATION_TOKEN, (tok) => {
        if (allowedTokens.has(tok)) return tok;
        fabricated.add(tok);
        return '';
      })
      .replace(/\s{2,}/g, ' ')
      .trim();

  const cleaned = items.map((item) => {
    const citations = item.citations
      .map((c) => c.trim().replace(/^\[|\]$/g, ''))
      .filter((c) => {
        if (!BARE_ID.test(c)) return false;
        if (allowedIds.has(c)) return true;
        fabricated.add(`[${c}]`);
        return false;
      });
    // EVERY free-text field is cleaned — a fabricated token must not ride
    // along in title/regulation/article either (review finding, fixed).
    return {
      ...item,
      citations,
      title: cleanText(item.title),
      regulation: cleanText(item.regulation),
      article: cleanText(item.article),
      description: cleanText(item.description),
      requirement: cleanText(item.requirement),
      currentState: cleanText(item.currentState),
      rationale: cleanText(item.rationale),
      sourceContext: cleanText(item.sourceContext),
    };
  });

  return { items: cleaned, fabricated: [...fabricated] };
}

// ───────────────────────── Deterministic mapping ─────────────────────────

const ID_PREFIX: Record<FindingType, string> = {
  finding: 'FND',
  gap: 'GAP',
  recommendation: 'REC',
};

/**
 * ExtractedItem → GapFinding. Purely deterministic TS: which column carries
 * which findingType, every status value and every marker is decided HERE, not
 * by the model (Scoring-Invariante). A recommendation maps to
 * status 'not_applicable' with an explicit [EMPFEHLUNG] prefix — it is not a
 * festgestellter Mangel and must never blur into one in the Excel.
 */
export function toGapFindings(
  items: ExtractedItem[],
  meta: {
    conversationId: string;
    messageId: string;
    mode: string;
    unverified: boolean;
    /** Running counter per prefix across the whole extraction run. */
    counters: Record<FindingType, number>;
  },
): GapFinding[] {
  return items.map((item) => {
    meta.counters[item.findingType] += 1;
    const id = `${ID_PREFIX[item.findingType]}-${String(meta.counters[item.findingType]).padStart(3, '0')}`;

    const firstCitation = item.citations[0];
    const req = firstCitation ? KB.byId(firstCitation) : undefined;

    // Precedence: the KB entry behind the VERIFIED citation wins over the
    // model-extracted name — a regulation name only enters the output path
    // citation-gated; the extracted text is the fallback, not the authority.
    const regulation = req
      ? regulationShortName(req.regulation)
      : item.regulation.trim();
    const article = req?.article || item.article.trim();

    const isRecommendation = item.findingType === 'recommendation';

    // Deterministic defaults for values the source did NOT state — the model
    // omits them (schema-optional); TS decides here and flags the row for
    // human review instead of trusting a model-chosen score.
    const severityAssumed = item.severity === undefined;
    const severity = item.severity ?? 'Medium';
    const statusAssumed = !isRecommendation && item.status === undefined;
    const status = item.status ?? 'missing';

    const assumedNote =
      severityAssumed || statusAssumed
        ? ' Severity/Status nicht in der Quelle ausgesagt — deterministischer Default, manuell prüfen.'
        : '';

    const unverifiedPrefix = meta.unverified ? `${UNVERIFIED_SOURCE_NOTE_DE} ` : '';
    const evidence =
      `Quelle: Unterhaltung ${meta.conversationId}, Nachricht ${meta.messageId} ` +
      `(Modus ${meta.mode}).${meta.unverified ? ` ${UNVERIFIED_SOURCE_NOTE_DE}` : ''}`;

    return {
      id,
      regulation,
      article,
      requirementId: firstCitation ?? '',
      requirementTitle: req ? (req.titleDe?.trim() || req.title || '') : '',
      requirementArea: '',
      policySection: `Chat-Analyse (${meta.mode})`,
      policyExcerpt:
        item.sourceContext.trim() || item.currentState.trim() || NO_POLICY_EXCERPT,
      status: isRecommendation ? 'not_applicable' : status,
      gapDescription: isRecommendation
        ? `[EMPFEHLUNG] ${item.description}`
        : item.description,
      riskImpact: `${unverifiedPrefix}${item.rationale.trim() || item.description}`,
      severity,
      recommendation: isRecommendation ? item.description : '',
      evidence,
      citations: item.citations,
      confidence: item.confidence,
      reason:
        (isRecommendation
          ? 'Empfehlung aus verifizierter Chat-Antwort — kein festgestellter Mangel.'
          : `Aus verifizierter Chat-Antwort extrahiert (${item.findingType}).`) + assumedNote,
      manualReview:
        meta.unverified || item.confidence < 0.5 || severityAssumed || statusAssumed,
    } satisfies GapFinding;
  });
}

// ───────────────────────── Entry point ─────────────────────────

export type ExtractConversationArgs = {
  conversationId: string;
  sessionId: string | null;
  userId?: string | null;
  /** Optional: restrict extraction to these assistant message ids. */
  messageIds?: string[];
};

export type ExtractConversationResult = {
  findings: GapFinding[];
  sourceRef: ConversationSourceRef;
};

type Transcript = { messages: MemoryMessage[] };

export type ExtractDeps = {
  call?: typeof callStructured;
  /** Ownership-scoped loader (session OR user scope) — injectable for tests. */
  loadOwnedTranscript?: (
    conversationId: string,
    sessionId: string | null,
    userId: string | null,
  ) => Promise<Transcript | null>;
  /** Cost hook — every classification/extraction call is reported (ToolContext.onUsage). */
  onUsage?: (model: (typeof MODEL_IDS)[keyof typeof MODEL_IDS], usage: ClaudeUsage) => void;
};

async function defaultLoadOwnedTranscript(
  conversationId: string,
  sessionId: string | null,
  userId: string | null,
): Promise<Transcript | null> {
  // Same ownership ladder as the memory turn: browser session first, then the
  // signed-in user (conversation opened from history on another device).
  return (
    (await getTranscript(conversationId, sessionId)) ??
    (userId ? await getTranscriptForUser(conversationId, userId) : null)
  );
}

export async function extractConversationFindings(
  args: ExtractConversationArgs,
  deps: ExtractDeps = {},
): Promise<ExtractConversationResult> {
  const call = deps.call ?? callStructured;
  const load = deps.loadOwnedTranscript ?? defaultLoadOwnedTranscript;

  // 1 — Ownership FIRST. Unknown, foreign and expired ids fail identically
  // (no existence oracle) and BEFORE any model call or content processing.
  const transcript = await load(args.conversationId, args.sessionId, args.userId ?? null);
  if (!transcript) {
    throw new Error(FILL_CONVERSATION_NOT_FOUND_DE);
  }

  const wanted = args.messageIds?.length ? new Set(args.messageIds) : null;
  const sources = transcript.messages.filter(
    (m) =>
      m.role === 'assistant' &&
      m.status === 'complete' &&
      m.content.trim().length > 0 &&
      (!wanted || wanted.has(m.id)),
  );

  const counters: Record<FindingType, number> = { finding: 0, gap: 0, recommendation: 0 };
  const findings: GapFinding[] = [];
  const usedMessageIds: string[] = [];
  const modeByMessage: Record<string, string> = {};
  const unverifiedMessageIds: string[] = [];
  const fabricatedTotal: string[] = [];

  for (const m of sources) {
    const mode = m.mode ?? 'CONVERSATIONAL';

    // 2 — CONVERSATIONAL gate: most free-chat answers carry no findings.
    if (mode === 'CONVERSATIONAL') {
      try {
        const { value, usage } = await call<{ containsFindings?: unknown }>({
          model: MODEL_IDS.haiku,
          system: CLASSIFY_SYSTEM,
          prompt: m.content,
          schema: CLASSIFY_JSON_SCHEMA,
          maxTokens: 50,
        });
        deps.onUsage?.(MODEL_IDS.haiku, usage);
        if (value?.containsFindings !== true) continue;
      } catch {
        continue; // conservative: unclassifiable → skip, never guess
      }
    }

    // 3 — Extraction (Sonnet), Zod-validated. A failed parse skips the message.
    let items: ExtractedItem[];
    try {
      const { value, usage } = await call<unknown>({
        model: MODEL_IDS.sonnet,
        system: `${EXTRACT_SYSTEM_BASE}\n\n${MODE_INSTRUCTION[mode] ?? MODE_INSTRUCTION.CONVERSATIONAL}`,
        prompt: m.content,
        schema: EXTRACTION_JSON_SCHEMA,
        maxTokens: 4000,
      });
      deps.onUsage?.(MODEL_IDS.sonnet, usage);
      const parsed = ExtractionResult.safeParse(value);
      if (!parsed.success) continue;
      items = parsed.data.items;
    } catch {
      continue;
    }
    if (items.length === 0) continue;

    // 4 — Citation firewall against THIS message's literal content.
    const { items: cleaned, fabricated } = enforceItemCitations(items, m.content);
    fabricatedTotal.push(...fabricated);

    // 5 — Deterministic mapping (incl. unverified marking).
    const unverified = isUnverifiedSource(m);
    if (unverified) unverifiedMessageIds.push(m.id);
    usedMessageIds.push(m.id);
    modeByMessage[m.id] = mode;
    findings.push(
      ...toGapFindings(cleaned, {
        conversationId: args.conversationId,
        messageId: m.id,
        mode,
        unverified,
        counters,
      }),
    );
  }

  if (fabricatedTotal.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'conversation_findings_fabricated_citations_stripped',
        conversationId: args.conversationId,
        fabricated: fabricatedTotal,
      }),
    );
  }

  return {
    findings,
    sourceRef: {
      kind: 'conversation',
      conversationId: args.conversationId,
      messageIds: usedMessageIds,
      modeByMessage,
      unverifiedMessageIds,
      extractedAt: new Date().toISOString(),
    },
  };
}

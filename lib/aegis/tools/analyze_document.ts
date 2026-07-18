import type Anthropic from '@anthropic-ai/sdk';
import { getDocument } from '../document-store';
import { saveFindings } from '../findings-store';
import { buildGapFinding, dedupeFindings, type GapFinding } from '../gap-finding';
import {
  assessApplicability,
  assessCoverage,
  extractEvidence,
  getConfidenceThreshold,
  type Coverage,
} from '../coverage';
import { runSemanticPass, semanticPassEnabled, type SemanticVerdict } from '../semantic-coverage';
import { selectExportFindings } from '../export-selection';
import { KB } from '@/lib/kb';
import type { Requirement } from '@/lib/kb/types';
import type { ToolContext } from '../types';

// Re-export so existing importers (`from '../tools/analyze_document'`) keep working.
export type { GapFinding } from '../gap-finding';

export const ANALYZE_DOCUMENT_SCHEMA: Anthropic.Tool = {
  name: 'analyze_document',
  description:
    'Analyse a previously uploaded policy document against the RegCompass knowledge base. ' +
    'Returns gap findings showing which regulatory requirements are covered, partially covered, or missing. ' +
    'Upload a document first via /api/aegis/upload, then pass the returned fileId here.',
  input_schema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The fileId returned from the upload endpoint.',
      },
      targetRegulation: {
        type: 'string',
        description: 'Optional: limit analysis to a specific regulation (e.g. EU_AI_ACT, DORA, GDPR).',
        enum: [
          'EU_AI_ACT', 'DORA', 'GDPR', 'NIS2', 'DSA', 'DATA_ACT',
          'PRODUCT_LIABILITY', 'FINMA_08_2024', 'FINMA_RS_2023_1',
          'FINMA_RS_2018_3', 'REVDSG', 'BDSG', 'BSIG', 'MARISK', 'BAIT',
          'ISO_42001', 'ISO_42005', 'ISO_23894', 'NIST_AI_RMF',
        ],
      },
    },
    required: ['documentId'],
  },
};

const CHUNK_SIZE = 4000;

// Near-zero guard, deliberately looser than MIN_EXTRACTABLE_CHARS in
// app/api/aegis/upload/route.ts (lib/aegis must not import from app/, and
// short plain-text uploads legitimately pass the route). Documents can reach
// analysis through paths other than the upload route (ingest, seeds), so
// this guard is defense-in-depth against the empty-extraction case, not
// redundancy.
const MIN_ANALYZABLE_CHARS = 20;

function chunkCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHUNK_SIZE));
}

export type AnalyzeDocumentInput = {
  documentId: string;
  targetRegulation?: string;
};

export type AnalyzeDocumentSummary = {
  /** Requirements evaluated (applicable). */
  applicable: number;
  /** Suppressed as meta-regulatory / authority-facing / low-relevance. */
  notApplicable: number;
  /** Suppressed because the policy already covers them. */
  covered: number;
  /** Exported partial gaps. */
  partial: number;
  /** Exported missing gaps (includes promoted core-DORA absences). */
  missing: number;
  /** Core-DORA manual-review findings promoted into the export set. */
  promoted: number;
  /** Held for manual review and NOT exported. */
  manualReview: number;
  /** Total findings exported (capped at 12). */
  exported: number;
  /** Requirements re-examined by the semantic pass (0 when disabled). */
  semanticChecked: number;
  /** Findings where the policy contradicts a requirement (verified quote). */
  contradictions: number;
};

export type AnalyzeDocumentResult = {
  documentId: string;
  filename: string;
  totalRequirementsChecked: number;
  /** Auto-exportable gap findings (the set the Excel exporter receives). */
  findings: GapFinding[];
  /** Below-threshold findings held for manual review (NOT exported). */
  reviewFindings: GapFinding[];
  summary: AnalyzeDocumentSummary;
  /**
   * Honest processing statement for the user (German): how much text was
   * analyzed, in how many stages, and whether the semantic pass ran. The model
   * is instructed to surface this — a document is never silently part-read.
   */
  processingNote: string;
};

/**
 * Applicability & Coverage Engine. For every (filtered) KB requirement:
 *   applicability → evidence → coverage → (suppress | export | manual-review).
 * Only applicable, partial/missing, above-threshold, deduped findings are
 * exported; covered / not-applicable / low-confidence ones are suppressed.
 */
export async function executeAnalyzeDocument(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<AnalyzeDocumentResult> {
  const { documentId, targetRegulation } = input as AnalyzeDocumentInput;

  if (!documentId) {
    throw new Error('documentId is required. Upload a document first via /api/aegis/upload.');
  }

  const startedAt = Date.now();
  const doc = await getDocument(documentId, ctx.sessionId);
  if (!doc) {
    throw new Error(`Document "${documentId}" not found. It may have expired (24h TTL) or the ID is invalid.`);
  }

  const requirements = targetRegulation
    ? KB.requirements.filter((r) => r.regulation === targetRegulation)
    : KB.requirements;

  const threshold = getConfidenceThreshold();
  const policyText = doc.textContent;

  // Fail fast on documents without analyzable text (scanned/image-only PDFs
  // parse without error but yield nothing). Without this guard every
  // requirement scores 0 and the export promotes manual-review absences into
  // a confident gap report about a document that was never read (DOC-1).
  if (policyText.replace(/\s+/g, '').length < MIN_ANALYZABLE_CHARS) {
    throw new Error(
      `Dokument "${doc.filename}" enthält keinen auswertbaren Text — vermutlich ein gescanntes bzw. Bild-PDF. Analyse nicht möglich; bitte eine Version mit auswählbarem Text hochladen (OCR erforderlich).`,
    );
  }

  let notApplicable = 0;
  let covered = 0;
  let contradictions = 0;
  const candidates: GapFinding[] = [];
  const reviewFindings: GapFinding[] = [];

  // Pass 1 — deterministic engine over EVERY applicable requirement (the
  // grounding layer; scans the FULL text, no truncation).
  const assessed: { req: Requirement; det: Coverage; evidence: ReturnType<typeof extractEvidence> }[] = [];
  for (const req of requirements) {
    const app = assessApplicability(req);
    if (!app.applicable) {
      notApplicable++;
      continue;
    }
    const evidence = extractEvidence(policyText, req);
    const det = assessCoverage(req, evidence);
    assessed.push({ req, det, evidence });
  }

  // Pass 2 — bounded semantic pass (Haiku): semantic reading, weak-provision
  // judgement, contradiction detection. Quote-firewalled; never fails the run.
  const semantic = await runSemanticPass({
    policyText,
    candidates: assessed.map(({ req, det }) => ({ req, det })),
    onUsage: ctx.onUsage
      ? (model, usage) => ctx.onUsage?.(model as Parameters<NonNullable<ToolContext['onUsage']>>[0], usage)
      : undefined,
  });

  // Merge — the deterministic verdict stands unless a QUOTE-VERIFIED semantic
  // verdict adjusts it. Severity is never model-assigned (deriveSeverity only).
  for (const { req, det, evidence } of assessed) {
    const sem: SemanticVerdict | undefined = semantic.verdicts.get(req.id);

    if (det.status === 'covered') {
      if (sem && (sem.verdict === 'partial' || sem.verdict === 'contradiction') && sem.quote) {
        // Weak provision or contradiction inside a keyword-"covered" requirement.
        const isContra = sem.verdict === 'contradiction';
        if (isContra) contradictions++;
        candidates.push(
          buildGapFinding({
            req,
            status: 'partial',
            confidence: isContra ? 0.8 : 0.75,
            reason: `${isContra ? 'Widerspruch' : 'Semantische Prüfung'}: ${sem.note}`,
            policyExcerpt: sem.quote,
            policySection: evidence.section,
          }),
        );
        const last = candidates[candidates.length - 1];
        if (isContra) last.contradiction = true;
        continue;
      }
      covered++;
      continue;
    }

    // det partial/missing:
    if (sem?.verdict === 'covered' && sem.quote) {
      // Semantic veto of a keyword miss (synonyms/other language) — suppress.
      covered++;
      continue;
    }

    let status = det.status;
    let confidence = det.confidence;
    let reason = det.reason;
    let excerpt = evidence.positives[0] ?? '';
    let isContra = false;

    if (sem?.verdict === 'contradiction' && sem.quote) {
      status = 'partial';
      confidence = Math.max(confidence, 0.8);
      reason = `Widerspruch: ${sem.note}`;
      excerpt = sem.quote;
      isContra = true;
      contradictions++;
    } else if (sem?.verdict === 'partial' && sem.quote && det.status === 'missing') {
      status = 'partial';
      confidence = Math.max(confidence, 0.75);
      reason = `Semantische Prüfung: ${sem.note}`;
      excerpt = sem.quote;
    }

    const belowThreshold = confidence < threshold;
    const finding = buildGapFinding({
      req,
      status,
      confidence,
      reason,
      policyExcerpt: excerpt,
      negativeEvidence: evidence.negative,
      policySection: evidence.section,
      manualReview: belowThreshold,
    });
    if (isContra) finding.contradiction = true;

    if (belowThreshold) {
      reviewFindings.push(finding);
    } else {
      candidates.push(finding);
    }
  }

  // Step 5 — duplicate suppression, then MVP export selection: keep the
  // high-confidence findings and promote core-DORA manual-review findings (where
  // absence is itself material) until the export lands in the 8–12 range.
  const deduped = dedupeFindings(candidates);
  const selection = selectExportFindings(deduped, reviewFindings);
  const findings = selection.exported;
  findings.forEach((f, i) => {
    f.id = `GAP-${String(i + 1).padStart(3, '0')}`;
  });
  selection.remainingReview.forEach((f, i) => {
    f.id = `REVIEW-${String(i + 1).padStart(3, '0')}`;
  });

  const summary: AnalyzeDocumentSummary = {
    applicable: requirements.length - notApplicable,
    notApplicable,
    covered,
    partial: findings.filter((f) => f.status === 'partial').length,
    missing: findings.filter((f) => f.status === 'missing').length,
    promoted: selection.promoted.length,
    manualReview: selection.remainingReview.length,
    exported: findings.length,
    semanticChecked: semantic.candidates,
    contradictions,
  };

  // Honest processing statement (surfaced to the user via the model): the FULL
  // document was analyzed — chunk count shows staging, semantic stats show the
  // model-assisted depth, and a ceiling cut (rare) would have been reported at
  // upload time already.
  const chunks = chunkCount(policyText);
  const semNote = semanticPassEnabled()
    ? semantic.candidates > 0
      ? ` Semantische Tiefenprüfung: ${semantic.candidates} Anforderungen in ${semantic.calls} Modell-Aufrufen${semantic.quotesRejected > 0 ? ` (${semantic.quotesRejected} unbelegte Modell-Zitate verworfen)` : ''}.`
      : ' Semantische Tiefenprüfung: keine unsicheren Anforderungen — nicht erforderlich.'
    : ' Semantische Tiefenprüfung: deaktiviert.';
  const processingNote =
    `Dokument vollständig analysiert: ${policyText.length.toLocaleString('de-DE')} Zeichen` +
    `${chunks > 1 ? ` in ${chunks} Abschnitten` : ''}.${semNote}`;

  // Persist the exported findings so the Excel-fill step reuses them (two-step
  // split). Best-effort — a cache failure must not fail the analysis turn.
  let findingsSaved = false;
  try {
    await saveFindings(ctx.sessionId, documentId, findings);
    findingsSaved = true;
  } catch (err) {
    console.error('[aegis/analyze_document] saveFindings failed:', err);
  }

  console.info(
    JSON.stringify({
      event: 'analyze_document',
      documentId,
      targetRegulation: targetRegulation ?? 'ALL',
      docChars: policyText.length,
      chunks: chunkCount(policyText),
      requirementsScanned: requirements.length,
      confidenceThreshold: threshold,
      findingsSaved,
      summary,
      durationMs: Date.now() - startedAt,
    }),
  );

  return {
    documentId,
    filename: doc.filename,
    totalRequirementsChecked: requirements.length,
    findings,
    reviewFindings: selection.remainingReview,
    summary,
    processingNote,
  };
}

import { storeDocument } from '../document-store';
import { getSavedFindings } from '../findings-store';
import { executeAnalyzeDocument } from '../tools/analyze_document';
import { extractConversationFindings } from '../conversation-findings';
import type { FillSourceRef } from '../tools/fill_template';
import type { GapFinding } from '../gap-finding';
import type { ToolContext } from '../types';
import { FILL_NO_FINDINGS_DE, FILL_NO_SOURCE_DE } from '../statusLabels';
import { buildReportModel, fmtDateFile, type AssessmentReport } from './report-model';
import { buildAssessmentWorkbook } from './xlsx';
import { buildAssessmentDocx } from './docx';
import { buildAssessmentPdf } from './pdf';
import { verifyExport } from './verify';

/**
 * Unified export engine: any assessment (uploaded-document analysis or
 * findings born in the conversation) → a verified, downloadable deliverable.
 * Formats: xlsx (from-scratch workbook), docx, pdf. PPTX lives in the deck
 * pipeline (generate_assessment_deck), not here.
 *
 * Generation is deterministic TS — the only model spend possible is the
 * conversation-findings extraction (same path fill_template uses), reported
 * through ctx.onUsage.
 */

export type ExportFormat = 'xlsx' | 'docx' | 'pdf';

export const EXPORT_FORMATS: ExportFormat[] = ['xlsx', 'docx', 'pdf'];

export type ExportAssessmentInput = {
  format: ExportFormat;
  /** Optional uploaded policy document as the finding source. */
  policyDocumentId?: string;
  /** Conversation source only: restrict to specific assistant message ids. */
  messageIds?: string[];
  /** Limit to specific regulations (lenient name matching, empty = all). */
  regulations?: string[];
  /** Optional deliverable title (defaults to the German standard title). */
  title?: string;
};

export type ExportAssessmentResult = {
  downloadId: string;
  filename: string;
  format: ExportFormat;
  sourceRef: FillSourceRef;
  summary: {
    total: number;
    gaps: number;
    manualReview: number;
    citedRequirements: number;
    rejected: number;
  };
};

const FORMAT_EXT: Record<ExportFormat, string> = { xlsx: 'xlsx', docx: 'docx', pdf: 'pdf' };

/** Lenient regulation filter — same semantics as fill_template. */
export function filterByRegulations(findings: GapFinding[], regulations?: string[]): GapFinding[] {
  if (!regulations || regulations.length === 0) return findings;
  const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
  const wanted = regulations.map(norm);
  return findings.filter((f) => {
    const fr = norm(f.regulation);
    return wanted.some((w) => fr === w || fr.includes(w) || w.includes(fr));
  });
}

async function resolveFindings(
  input: ExportAssessmentInput,
  ctx: ToolContext,
): Promise<{ findings: GapFinding[]; sourceRef: FillSourceRef }> {
  const sessionId = ctx.sessionId;
  if (input.policyDocumentId) {
    if (!sessionId) throw new Error(FILL_NO_SOURCE_DE);
    const saved = await getSavedFindings(sessionId, input.policyDocumentId);
    const findings =
      saved ??
      (
        await executeAnalyzeDocument(
          {
            documentId: input.policyDocumentId,
            targetRegulation: input.regulations?.length === 1 ? input.regulations[0] : undefined,
          },
          ctx,
        )
      ).findings;
    return { findings, sourceRef: { kind: 'document', documentId: input.policyDocumentId } };
  }

  const conversationId = ctx.conversationId;
  if (!conversationId) throw new Error(FILL_NO_SOURCE_DE);
  const extracted = await extractConversationFindings(
    {
      conversationId,
      sessionId,
      userId: ctx.userId ?? null,
      messageIds: input.messageIds,
    },
    { onUsage: ctx.onUsage },
  );
  return { findings: extracted.findings, sourceRef: extracted.sourceRef };
}

async function buildBuffer(format: ExportFormat, report: AssessmentReport): Promise<Buffer> {
  if (format === 'xlsx') return buildAssessmentWorkbook(report);
  if (format === 'docx') return buildAssessmentDocx(report);
  return buildAssessmentPdf(report);
}

/**
 * Full pipeline: resolve findings → canonical report model → format builder →
 * independent re-open verification → session-scoped storage. Throws German,
 * user-safe errors on every failure path; a file that fails verification is
 * never stored or delivered.
 */
export async function exportAssessment(
  input: ExportAssessmentInput,
  ctx: ToolContext,
): Promise<ExportAssessmentResult> {
  if (!ctx.sessionId) throw new Error(FILL_NO_SOURCE_DE);
  const startedAt = Date.now();

  const { findings, sourceRef } = await resolveFindings(input, ctx);
  const filtered = filterByRegulations(findings, input.regulations);
  if (filtered.length === 0) throw new Error(FILL_NO_FINDINGS_DE);

  const report = buildReportModel({ findings: filtered, title: input.title, sourceRef });
  if (report.findings.length === 0) throw new Error(FILL_NO_FINDINGS_DE);

  const buffer = await buildBuffer(input.format, report);
  await verifyExport(input.format, buffer, report);

  const filename = `AEGIS_Assessment_${fmtDateFile(report.meta.generatedAt)}.${FORMAT_EXT[input.format]}`;
  const downloadId = await storeDocument(
    {
      filename,
      type: 'export',
      textContent:
        `Export (${input.format}): ${report.findings.length} Befunde — ` +
        `Quelle: ${JSON.stringify(sourceRef)}`,
      excelBuffer: buffer,
    },
    ctx.sessionId,
  );

  const summary = {
    total: report.counts.total,
    gaps: report.counts.byStatus.missing + report.counts.byStatus.partial,
    manualReview: report.counts.manualReview,
    citedRequirements: report.citedRequirements.length,
    rejected: report.rejected.length,
  };

  console.info(
    JSON.stringify({
      event: 'export_assessment',
      format: input.format,
      source: sourceRef.kind,
      findings: report.findings.length,
      rejected: report.rejected.length,
      unresolvedCitations: report.unresolvedCitations.length,
      bytes: buffer.length,
      durationMs: Date.now() - startedAt,
    }),
  );

  return { downloadId, filename, format: input.format, sourceRef, summary };
}

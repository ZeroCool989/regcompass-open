import type Anthropic from '@anthropic-ai/sdk';
import { getDocument, storeDocument } from '../document-store';
import { fillExcelTemplate } from '../parsers/excel-writer';
import { executeAnalyzeDocument, type GapFinding } from './analyze_document';
import { getSavedFindings } from '../findings-store';
import { getRegulatoryOutlook } from '@/lib/regulatory/news-query';
import {
  extractConversationFindings,
  type ConversationSourceRef,
} from '../conversation-findings';
import { FILL_NO_FINDINGS_DE, FILL_NO_SOURCE_DE } from '../statusLabels';
import type { ToolContext } from '../types';

export const FILL_TEMPLATE_SCHEMA: Anthropic.Tool = {
  name: 'fill_template',
  description:
    'Füllt ein hochgeladenes Excel-Assessment-Template mit Assessment-Ergebnissen aus. ' +
    'Erstellt immer ein sauberes, formatiertes "AEGIS Lückenanalyse" Sheet mit den finalen Findings. ' +
    'Der Sheet-Name wird automatisch erkannt — NICHT den Benutzer danach fragen. ' +
    'ZWEI Quellen möglich: (1) ein hochgeladenes Policy-Dokument (policyDocumentId), ' +
    '(2) OHNE policyDocumentId werden die Findings aus der AKTUELLEN Unterhaltung extrahiert — ' +
    'biete das aktiv an ("Ich kann die Findings aus dieser Analyse direkt eintragen"), wenn die ' +
    'Analyse im Chat entstanden ist. Fordere NIEMALS einen Dummy-Upload an. ' +
    'Das Excel-Template muss in beiden Fällen via /api/aegis/upload hochgeladen sein.',
  input_schema: {
    type: 'object',
    properties: {
      policyDocumentId: {
        type: 'string',
        description:
          'Optional. fileId of the uploaded policy document (PDF/DOCX/TXT). ' +
          'Omit it to use the findings from the CURRENT conversation instead.',
      },
      templateDocumentId: {
        type: 'string',
        description: 'fileId of the uploaded Excel assessment template.',
      },
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional (conversation source only): restrict extraction to these assistant message ids. ' +
          'Empty/omitted = all assistant answers of the conversation.',
      },
      targetSheet: {
        type: 'string',
        description:
          'Optional. Name of a template sheet to also fill in place. If omitted or not found, ' +
          'it is auto-detected — the "AEGIS Lückenanalyse" sheet is generated either way.',
      },
      regulations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit to specific regulations (empty = all).',
      },
      includeRegulatoryOutlook: {
        type: 'boolean',
        description:
          'Optional (default false). Auf true setzen, wenn der Nutzer einen "regulatorischen Ausblick", kommende/aktuelle Behörden- oder Aufsichtsmeldungen bzw. "was von den Regulatoren kommt" in der Excel wünscht. Fügt ein zusätzliches Sheet "Regulatorischer Ausblick" mit quellenbasierten Radar-Meldungen NUR zu den abgedeckten Regulierungen hinzu (keine erfundenen Inhalte).',
      },
    },
    required: ['templateDocumentId'],
  },
};

export type FillTemplateInput = {
  /** Optional since the conversation source exists — omit to fill from chat findings. */
  policyDocumentId?: string;
  templateDocumentId: string;
  /** Conversation source only: restrict to specific assistant messages. */
  messageIds?: string[];
  targetSheet?: string;
  regulations?: string[];
  includeRegulatoryOutlook?: boolean;
};

/** Persisted provenance of a fill run — every cell is traceable to its source. */
export type FillSourceRef =
  | { kind: 'document'; documentId: string }
  | ConversationSourceRef;

export type FillTemplateResult = {
  downloadId: string;
  filename: string;
  /** Full provenance record (kind, IDs, messageIds, mode per finding source, timestamp). */
  sourceRef: FillSourceRef;
  summary: {
    filled: number;
    added: number;
    gaps: number;
    total: number;
  };
};

export async function executeFillTemplate(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<FillTemplateResult> {
  const {
    policyDocumentId,
    templateDocumentId,
    messageIds,
    targetSheet,
    regulations,
    includeRegulatoryOutlook,
  } = input as FillTemplateInput;

  if (!templateDocumentId) {
    throw new Error('templateDocumentId is required.');
  }

  const sessionId = ctx.sessionId;
  if (!sessionId) {
    throw new Error('No session — upload the documents first via /api/aegis/upload.');
  }

  const templateDoc = await getDocument(templateDocumentId, sessionId);
  if (!templateDoc || !templateDoc.excelBuffer) {
    throw new Error(`Template document "${templateDocumentId}" not found or is not an Excel file.`);
  }

  const startedAt = Date.now();

  let findings: GapFinding[];
  let reusedSavedFindings = false;
  let sourceRef: FillSourceRef;

  if (policyDocumentId) {
    // ── Source: uploaded policy document — the pre-existing path, unchanged. ──
    const policyDoc = await getDocument(policyDocumentId, sessionId);
    if (!policyDoc) {
      throw new Error(`Policy document "${policyDocumentId}" not found.`);
    }

    // Step-2 reuse: prefer the findings saved by the earlier GAP_ANALYZE turn so
    // the fill is cheap and never re-runs the full document analysis. Only fall
    // back to a fresh analysis when no saved findings exist (e.g. they expired, or
    // the user jumped straight to filling without analyzing first).
    const saved = await getSavedFindings(sessionId, policyDocumentId);
    if (saved) {
      findings = saved;
      reusedSavedFindings = true;
    } else {
      const analysisResult = await executeAnalyzeDocument(
        {
          documentId: policyDocumentId,
          targetRegulation: regulations?.length === 1 ? regulations[0] : undefined,
        },
        ctx,
      );
      findings = analysisResult.findings;
      reusedSavedFindings = false;
    }
    sourceRef = { kind: 'document', documentId: policyDocumentId };
  } else {
    // ── Source: the current conversation (assessments born purely in chat). ──
    // Ownership is checked inside extractConversationFindings BEFORE any
    // processing; the conversation id comes from the request context, never
    // from the model.
    const conversationId = ctx.conversationId;
    if (!conversationId) {
      throw new Error(FILL_NO_SOURCE_DE);
    }
    const extracted = await extractConversationFindings(
      {
        conversationId,
        sessionId,
        userId: ctx.userId ?? null,
        messageIds,
      },
      // Cost hook: extraction spend lands in the run's CostAccumulator
      // (cost cap + usage dashboard), not in a blind spot.
      { onUsage: ctx.onUsage },
    );
    if (extracted.findings.length === 0) {
      throw new Error(FILL_NO_FINDINGS_DE);
    }
    findings = extracted.findings;
    sourceRef = extracted.sourceRef;
  }

  if (regulations && regulations.length > 0) {
    // GapFinding.regulation is a display name (e.g. "DORA", "EU AI Act") while
    // callers may pass enum values (e.g. "EU_AI_ACT"). Match leniently on a
    // normalized form so neither style is silently dropped.
    const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
    const wanted = regulations.map(norm);
    findings = findings.filter((f) => {
      const fr = norm(f.regulation);
      return wanted.some((w) => fr === w || fr.includes(w) || w.includes(fr));
    });
  }

  // Opt-in regulatory outlook: only news for the regulations actually present in
  // the (filtered) findings. Echo-only; empty when nothing matches.
  const outlook = includeRegulatoryOutlook
    ? await getRegulatoryOutlook({
        regulations: [...new Set(findings.map((f) => f.regulation).filter(Boolean))],
      })
    : [];

  const filledBuffer = await fillExcelTemplate(
    templateDoc.excelBuffer,
    targetSheet,
    findings,
    { appendRows: true, fillExisting: true, addMissingSheet: true, outlook },
  );

  const downloadFilename = templateDoc.filename.replace(
    /\.xlsx$/i,
    '_AEGIS_filled.xlsx',
  );

  const downloadId = await storeDocument(
    {
      filename: downloadFilename,
      type: 'template',
      // Provenance travels with the stored result: every fill run names its
      // source (document id or conversation + message ids) in the record.
      textContent: `Filled template: ${findings.length} findings — Quelle: ${JSON.stringify(sourceRef)}`,
      excelBuffer: filledBuffer,
    },
    sessionId,
  );

  const summary = {
    filled: findings.filter((f) => f.status === 'covered' || f.status === 'partial').length,
    added: findings.filter((f) => f.status === 'missing').length,
    gaps: findings.filter((f) => f.status === 'missing' || f.status === 'partial').length,
    total: findings.length,
  };

  // Telemetry: fill duration + whether saved findings were reused (the whole
  // point of the split — reused:true means no re-analysis happened here).
  console.info(
    JSON.stringify({
      event: 'fill_template',
      source: sourceRef.kind,
      reusedSavedFindings,
      findings: findings.length,
      summary,
      durationMs: Date.now() - startedAt,
    }),
  );

  return {
    downloadId,
    filename: downloadFilename,
    sourceRef,
    summary,
  };
}

import type Anthropic from '@anthropic-ai/sdk';
import { exportAssessment, EXPORT_FORMATS, type ExportAssessmentResult } from '../export';
import type { ToolContext } from '../types';

/**
 * Terminal deliverable tool: export the current assessment as a from-scratch
 * Excel workbook, Word document or PDF — no uploaded template required
 * (fill_template remains the tool for filling an UPLOADED template).
 */
export const EXPORT_ASSESSMENT_SCHEMA: Anthropic.Tool = {
  name: 'export_assessment',
  description:
    'Exportiert die Assessment-Ergebnisse als eigenständige, professionell formatierte Datei — ' +
    'OHNE hochgeladenes Template. Formate: "xlsx" (Excel-Arbeitsmappe mit Deckblatt, Lückenanalyse, ' +
    'Zusammenfassung und Verifikationsanhang), "docx" (Word-Bericht), "pdf" (PDF-Bericht). ' +
    'ZWEI Quellen möglich: (1) ein hochgeladenes Policy-Dokument (policyDocumentId), ' +
    '(2) OHNE policyDocumentId werden die Findings aus der AKTUELLEN Unterhaltung extrahiert. ' +
    'Nutze dieses Tool, wenn der Nutzer einen Export/Bericht als Excel, Word oder PDF wünscht ' +
    '("exportiere das als Excel", "als PDF", "erstelle einen Word-Bericht"). ' +
    'Für das Befüllen eines HOCHGELADENEN Excel-Templates stattdessen fill_template verwenden; ' +
    'für PowerPoint generate_assessment_deck.',
  input_schema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: [...EXPORT_FORMATS],
        description: 'Zielformat: xlsx, docx oder pdf.',
      },
      policyDocumentId: {
        type: 'string',
        description:
          'Optional. fileId des hochgeladenen Policy-Dokuments. Weglassen, um die Findings ' +
          'aus der aktuellen Unterhaltung zu verwenden.',
      },
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional (nur Unterhaltungs-Quelle): Extraktion auf diese Assistent-Nachrichten beschränken.',
      },
      regulations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: auf bestimmte Regulierungen einschränken (leer = alle).',
      },
      title: {
        type: 'string',
        description: 'Optional: Titel des Deliverables (Standard: "AEGIS Regulatorisches Assessment").',
      },
    },
    required: ['format'],
  },
};

export type ExportAssessmentToolInput = {
  format: 'xlsx' | 'docx' | 'pdf';
  policyDocumentId?: string;
  messageIds?: string[];
  regulations?: string[];
  title?: string;
};

export async function executeExportAssessment(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<ExportAssessmentResult> {
  const { format, policyDocumentId, messageIds, regulations, title } =
    input as ExportAssessmentToolInput;
  if (!format || !(EXPORT_FORMATS as string[]).includes(format)) {
    throw new Error('Ungültiges Format — zulässig sind xlsx, docx oder pdf.');
  }
  return exportAssessment({ format, policyDocumentId, messageIds, regulations, title }, ctx);
}

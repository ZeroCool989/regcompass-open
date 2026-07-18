import type Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { rankPassages } from './_passages';

/**
 * search_ingested_documents — searches the radar-ingested document corpus
 * (RegulatoryDocument rows, status=INGESTED) stored in Postgres. These are
 * regulation texts an admin accepted from the daily radar and that were
 * fetched + converted at runtime; they are NOT part of the curated KB.
 *
 * Like read_source, every passage is flagged `verified: false`. The system
 * prompt requires the agent to mark any answer derived from these with
 * "⚠️ Quelle: extern eingespeist (nicht in KB verifiziert)".
 */

const ABSOLUTE_MAX_PASSAGES = 6;
const MAX_DOCS_SCANNED = 25;

export const SEARCH_INGESTED_DOCUMENTS_SCHEMA: Anthropic.Tool = {
  name: 'search_ingested_documents',
  description:
    'Searches the runtime regulation-document corpus (accepted from the daily Regulatorik-News radar AND machine-translated documents — NOT curated KB). ' +
    'Use this when search_kb has too few hits for a recent regulation/development that may have been ingested or translated. ' +
    'Returns ranked passages, each marked `verified: false`; passages with `machineTranslated: true` come from a DeepL translation. The agent MUST mark any answer derived from these with "⚠️ Quelle: extern eingespeist (nicht in KB verifiziert)", and additionally "(maschinell übersetzt, DeepL)" when machineTranslated is true.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query in DE or EN. Tokenised; passages with the most token hits rank first.',
      },
      regulation: {
        type: 'string',
        description: 'Optional regulation filter (substring match, e.g. "DORA", "EU AI Act"). Omit to search all ingested documents.',
      },
      maxPassages: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        default: 4,
        description: 'Maximum number of passages to return. Capped at 6.',
      },
    },
    required: ['query'],
  },
};

type SearchIngestedInput = {
  query: string;
  regulation?: string;
  maxPassages?: number;
};

export type IngestedPassage = {
  source: 'ingested_document';
  verified: false;
  documentId: string;
  title: string;
  regulation: string;
  sourceName: string;
  sourceUrl: string;
  /** True for a DeepL machine-translation — answer must carry the translated-source marker. */
  machineTranslated: boolean;
  originalLanguage: string | null;
  targetLanguage: string | null;
  passage: string;
  score: number;
};

export async function executeSearchIngestedDocuments(
  input: SearchIngestedInput,
): Promise<IngestedPassage[]> {
  const where: { status: 'INGESTED'; regulation?: { contains: string; mode: 'insensitive' } } = {
    status: 'INGESTED',
  };
  if (input.regulation && input.regulation.trim()) {
    where.regulation = { contains: input.regulation.trim(), mode: 'insensitive' };
  }

  const docs = await db.regulatoryDocument.findMany({
    where,
    orderBy: { fetchedAt: 'desc' },
    take: MAX_DOCS_SCANNED,
    select: {
      id: true,
      title: true,
      regulation: true,
      sourceName: true,
      sourceUrl: true,
      documentUrl: true,
      markdown: true,
      rawText: true,
      isTranslation: true,
      originalLanguage: true,
      targetLanguage: true,
    },
  });

  const cap = Math.min(Math.max(input.maxPassages ?? 4, 1), ABSOLUTE_MAX_PASSAGES);

  const all: IngestedPassage[] = [];
  for (const doc of docs) {
    const text = doc.markdown ?? doc.rawText ?? '';
    if (!text) continue;
    for (const { passage, score } of rankPassages(text, input.query, cap)) {
      all.push({
        source: 'ingested_document',
        verified: false,
        documentId: doc.id,
        title: doc.title,
        regulation: doc.regulation,
        sourceName: doc.sourceName,
        sourceUrl: doc.documentUrl ?? doc.sourceUrl,
        machineTranslated: doc.isTranslation,
        originalLanguage: doc.originalLanguage,
        targetLanguage: doc.targetLanguage,
        passage,
        score,
      });
    }
  }

  all.sort((a, b) => b.score - a.score);
  return all.slice(0, cap);
}

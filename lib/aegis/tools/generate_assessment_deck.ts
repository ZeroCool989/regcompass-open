import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import { storeDocument } from '../document-store';
import { getSavedFindings } from '../findings-store';
import { buildDeckModel, type DeckOutlookItem } from '../deck/deck-model';
import { buildPptxBuffer, type BuildPptxResult } from '../deck/pptx-writer';
import { lintDeckBuffer, type DeckLintResult } from '../deck/deck-lint';
import { getRegulatoryOutlook, type OutlookItem } from '@/lib/regulatory/news-query';
import type { ToolContext } from '../types';

/**
 * generate_assessment_deck — "Create PowerPoint Management Summary".
 *
 * A terminal deliverable tool (like fill_template): it consumes already-produced
 * structured results and renders a real .pptx. It NEVER reasons about regulation
 * — `buildDeckModel` grounds every regulatory fact in the saved GapFindings +
 * the curated KB, dropping any requirement id it can't resolve.
 */
export const GENERATE_ASSESSMENT_DECK_SCHEMA: Anthropic.Tool = {
  name: 'generate_assessment_deck',
  description:
    'Erstellt eine PowerPoint-Management-Summary (.pptx) aus den strukturierten Ergebnissen einer Gap-Analyse oder Bewertung. ' +
    'Nutze dies NACH einer Gap-Analyse (mit policyDocumentId, deren Findings wiederverwendet werden) oder nach einer Assess-Bewertung (mit den zitierten requirementIds). ' +
    'Erfinde KEINE Findings oder Pflichten — gib nur die bereits ermittelten Requirement-IDs und die Rahmen-Angaben (Scope, Risikoklassifizierung) weiter; alle regulatorischen Inhalte werden aus KB/Findings aufgelöst. ' +
    'Antworte nach Erfolg mit einer kurzen Zeile + dem Dateinamen; die App rendert den Download-Button.',
  input_schema: {
    type: 'object',
    properties: {
      policyDocumentId: {
        type: 'string',
        description: 'fileId of the analysed policy document — its saved gap findings are reused (Gap-Analyse-Pfad).',
      },
      requirementIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Cited KB requirement IDs (e.g. "R-AIACT-005") for the Assess path. Validated against the KB; unknown IDs are dropped.',
      },
      title: { type: 'string', description: 'Deck title (optional).' },
      clientName: { type: 'string', description: 'Client / organisation name shown as subtitle (optional).' },
      scope: { type: 'string', description: 'Scope / use-case description from the assessment (echoed verbatim, no regulatory claim).' },
      riskClassification: {
        type: 'object',
        description: 'Risk classification framing from the assessment (model-derived; drivenBy IDs are KB-validated).',
        properties: {
          tier: { type: 'string', description: 'e.g. "Hochrisiko", "Begrenztes Risiko".' },
          rationale: { type: 'string', description: 'Why this tier — narrative.' },
          drivenBy: { type: 'array', items: { type: 'string' }, description: 'Requirement IDs that drive the tier.' },
        },
      },
      includeRegulatoryOutlook: {
        type: 'boolean',
        description:
          'Optional (default false). Auf true setzen, wenn der Nutzer einen "regulatorischen Ausblick", kommende/aktuelle Behörden- oder Aufsichtsmeldungen bzw. "was von den Regulatoren kommt" im Deck wünscht. Fügt eine zusätzliche Slide mit quellenbasierten Radar-Meldungen NUR zu den abgedeckten Regulierungen hinzu (keine erfundenen Inhalte).',
      },
    },
    required: [],
  },
};

export type GenerateAssessmentDeckInput = {
  policyDocumentId?: string;
  requirementIds?: string[];
  title?: string;
  clientName?: string;
  scope?: string;
  riskClassification?: { tier?: string; rationale?: string; drivenBy?: string[] };
  includeRegulatoryOutlook?: boolean;
};

/** Format a stored news item into the deck's outlook shape (echo only). */
function toDeckOutlook(o: OutlookItem): DeckOutlookItem {
  const dateLabel = o.publishedAt
    ? o.publishedAt.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  return { title: o.title, source: o.sourceName, dateLabel, relevance: o.relevance, url: o.sourceUrl };
}

export type GenerateAssessmentDeckResult = {
  downloadId: string;
  filename: string;
  summary: { findings: number; obligations: number; controls: number; slides: number };
};

function safeFilename(title: string | undefined): string {
  const base = (title?.trim() || 'AEGIS Management Summary')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'AEGIS_Management_Summary';
  return `${base}.pptx`;
}

export async function executeGenerateAssessmentDeck(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<GenerateAssessmentDeckResult> {
  const { policyDocumentId, requirementIds, title, clientName, scope, riskClassification, includeRegulatoryOutlook } =
    (input ?? {}) as GenerateAssessmentDeckInput;

  const sessionId = ctx.sessionId;
  if (!sessionId) {
    throw new Error('No session — run an assessment or gap analysis first.');
  }

  const startedAt = Date.now();

  // Gap-Analyse-Pfad: reuse the findings saved by the analyze step (same source
  // as fill_template). Assess-Pfad: rely on the validated requirementIds.
  const findings = policyDocumentId ? (await getSavedFindings(sessionId, policyDocumentId)) ?? [] : [];

  // Opt-in regulatory outlook: fetch radar news for ONLY the regulations this
  // deck covers (from findings + resolvable requirement IDs). Echo-only.
  let outlook: DeckOutlookItem[] = [];
  if (includeRegulatoryOutlook) {
    const coveredRegs = new Set<string>();
    for (const f of findings) if (f.regulation) coveredRegs.add(f.regulation);
    for (const id of requirementIds ?? []) {
      const req = KB.byId(id);
      if (req) coveredRegs.add(req.regulation);
    }
    if (coveredRegs.size > 0) {
      const items = await getRegulatoryOutlook({ regulations: [...coveredRegs] });
      outlook = items.map(toDeckOutlook);
    }
  }

  const generatedAtLabel = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  const model = buildDeckModel({
    title,
    clientName,
    scope,
    riskClassification,
    findings,
    requirementIds,
    generatedAtLabel,
    outlook,
  });

  if (!model) {
    throw new Error(
      'Keine strukturierten Bewertungsergebnisse vorhanden. Führe zuerst eine Gap-Analyse (analyze_document) durch oder übergib die zitierten Requirement-IDs.',
    );
  }

  // Build → lint → (compact retry) → deliver or refuse. The lint is the
  // in-process half of the verification pair (deck-lint.ts): a deck with hard
  // violations is never delivered; the compact density trades content per
  // slide for guaranteed fit before we give up.
  let result: BuildPptxResult = await buildPptxBuffer(model);
  let lint: DeckLintResult = lintDeckBuffer(result.buffer, result.slideCount);
  if (!lint.ok) {
    console.info(JSON.stringify({ event: 'deck_lint_retry', density: 'compact', hard: lint.hard, soft: lint.soft }));
    result = await buildPptxBuffer(model, { density: 'compact' });
    lint = lintDeckBuffer(result.buffer, result.slideCount);
  }
  if (!lint.ok) {
    console.error(JSON.stringify({ event: 'deck_lint_blocked', violations: lint.violations.slice(0, 10) }));
    throw new Error(
      'Die generierte Präsentation hat die automatische Strukturprüfung nicht bestanden und wird nicht ausgeliefert. ' +
        'Bitte reduzieren Sie den Umfang (weniger Findings/Anforderungen) oder exportieren Sie als Excel/Word.',
    );
  }

  const buffer = result.buffer;
  const filename = safeFilename(title);

  const lintLabel = lint.soft > 0 ? `lint: ok (${lint.soft} soft)` : 'lint: ok';
  const downloadId = await storeDocument(
    {
      filename,
      type: 'deck',
      textContent: `Management summary deck: ${model.findings.length} findings, ${model.obligations.length} obligations · ${lintLabel} · density: ${result.density}`,
      excelBuffer: buffer,
    },
    sessionId,
  );

  const summary = {
    findings: model.findings.length,
    obligations: model.obligations.length,
    controls: model.controls.length,
    slides: result.slideCount,
  };

  console.info(
    JSON.stringify({
      event: 'generate_assessment_deck',
      ...summary,
      bytes: buffer.length,
      density: result.density,
      lintSoft: lint.soft,
      durationMs: Date.now() - startedAt,
    }),
  );

  return { downloadId, filename, summary };
}

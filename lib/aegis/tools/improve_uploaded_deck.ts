import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import { getDocument, storeDocument } from '../document-store';
import { getSavedFindings } from '../findings-store';
import { improvePptx, parsePptxStructure, type ImproveOp } from '../deck/pptx-improve';
import { lintDeckBuffer } from '../deck/deck-lint';
import { SEVERITY_LABEL_DE, STATUS_LABEL_DE } from '../deck/deck-model';
import type { ToolContext } from '../types';

/**
 * improve_uploaded_deck — improve a client's uploaded .pptx WITHOUT destroying
 * its design: theme, masters, charts and metadata survive by construction
 * (surgical OOXML patching, see pptx-improve.ts).
 *
 * ANTI-HALLUCINATION CONTRACT: the model never supplies replacement regulatory
 * prose. `corrections` pairs a text snippet from THEIR deck with a KB
 * requirement ID — the replacement text is the KB entry's German summary. The
 * appended findings slide is built from saved GapFindings only. Unknown IDs
 * are dropped, never invented.
 */
export const IMPROVE_UPLOADED_DECK_SCHEMA: Anthropic.Tool = {
  name: 'improve_uploaded_deck',
  description:
    'Verbessert eine vom Nutzer HOCHGELADENE PowerPoint-Präsentation, ohne deren Design/Branding zu zerstören (Theme, Master, Diagramme bleiben unverändert). ' +
    'Zwei Operationen: (1) corrections — ersetzt veraltete/falsche regulatorische Aussagen im Deck durch die kuratierte KB-Zusammenfassung der angegebenen Requirement-ID; ' +
    '(2) appendFindings — hängt eine Folie im Layout des Kunden-Decks mit den Findings einer vorherigen Gap-Analyse an. ' +
    'Erfinde KEINE Ersatztexte: corrections nennen nur find-Text + requirementId; der Ersatztext kommt aus der KB.',
  input_schema: {
    type: 'object',
    properties: {
      deckDocumentId: {
        type: 'string',
        description: 'fileId der hochgeladenen .pptx (aus dem Upload).',
      },
      corrections: {
        type: 'array',
        description: 'Veraltete Aussagen im Deck: exakter find-Text + die KB-Requirement-ID, deren Zusammenfassung ihn ersetzt.',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string', description: 'Exakter Text im Deck, der ersetzt werden soll.' },
            requirementId: { type: 'string', description: 'KB-ID (z. B. "R-DORA-024"), deren summaryDe den Text ersetzt.' },
            slide: { type: 'number', description: 'Optional: nur auf dieser Folie (1-basiert) ersetzen.' },
          },
          required: ['find', 'requirementId'],
        },
      },
      appendFindings: {
        type: 'object',
        description: 'Optional: Findings-Folie im Kunden-Layout anhängen.',
        properties: {
          policyDocumentId: { type: 'string', description: 'fileId der analysierten Policy — deren gespeicherte Findings werden verwendet.' },
          title: { type: 'string', description: 'Folientitel (optional, Default "Regulatorische Findings — AEGIS").' },
        },
        required: ['policyDocumentId'],
      },
    },
    required: ['deckDocumentId'],
  },
};

export type ImproveUploadedDeckInput = {
  deckDocumentId?: string;
  corrections?: { find: string; requirementId: string; slide?: number }[];
  appendFindings?: { policyDocumentId: string; title?: string };
};

export type ImproveUploadedDeckResult = {
  downloadId: string;
  filename: string;
  replacements: number;
  appendedSlides: number;
  slideCount: number;
  skippedCorrections: string[];
};

const FINDINGS_SLIDE_CAP = 8;

export async function executeImproveUploadedDeck(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<ImproveUploadedDeckResult> {
  const { deckDocumentId, corrections, appendFindings } = (input ?? {}) as ImproveUploadedDeckInput;
  const sessionId = ctx.sessionId;
  if (!sessionId) throw new Error('Keine Session — bitte zuerst eine Präsentation hochladen.');
  if (!deckDocumentId) throw new Error('deckDocumentId fehlt — welche hochgeladene Präsentation soll verbessert werden?');

  const doc = await getDocument(deckDocumentId, sessionId);
  if (!doc) throw new Error('Die angegebene Präsentation wurde nicht gefunden (oder gehört zu einer anderen Session).');
  if (!doc.excelBuffer || !doc.filename.toLowerCase().endsWith('.pptx')) {
    throw new Error(
      'Für diese Datei liegt keine Original-.pptx vor. Bitte die Präsentation erneut hochladen — nur .pptx-Uploads können designerhaltend verbessert werden.',
    );
  }

  const startedAt = Date.now();
  const ops: ImproveOp[] = [];
  const skippedCorrections: string[] = [];

  // corrections → replaceText ops with KB-grounded replacement text ONLY.
  for (const c of corrections ?? []) {
    const req = c.find?.trim() ? KB.byId(c.requirementId) : null;
    const replacement = req ? (req.summaryDe?.trim() || req.summary?.trim()) : undefined;
    if (!req || !replacement) {
      skippedCorrections.push(c.requirementId ?? '(ohne ID)');
      continue; // unknown ID or empty find → dropped, never invented
    }
    ops.push({ type: 'replaceText', find: c.find, replace: `${replacement} [${req.id}]`, slide: c.slide });
  }

  // appendFindings → one appended slide in THEIR layout, from saved findings only.
  if (appendFindings?.policyDocumentId) {
    const findings = (await getSavedFindings(sessionId, appendFindings.policyDocumentId)) ?? [];
    if (findings.length > 0) {
      const lines = findings
        .slice(0, FINDINGS_SLIDE_CAP)
        .map(
          (f) =>
            `${f.regulation} ${f.article} — ${f.requirementTitle}: ${STATUS_LABEL_DE[f.status]} (${SEVERITY_LABEL_DE[f.severity]}) [${f.requirementId}]`,
        );
      if (findings.length > FINDINGS_SLIDE_CAP) {
        lines.push(`+ ${findings.length - FINDINGS_SLIDE_CAP} weitere Findings — vollständige Liste im AEGIS-Export.`);
      }
      ops.push({ type: 'appendSlide', title: appendFindings.title?.trim() || 'Regulatorische Findings — AEGIS', lines });
    }
  }

  if (ops.length === 0) {
    throw new Error(
      skippedCorrections.length > 0
        ? `Keine der angegebenen Requirement-IDs war in der Wissensbasis auflösbar (${skippedCorrections.join(', ')}) — nichts geändert.`
        : 'Keine anwendbaren Änderungen angegeben (corrections leer, keine Findings gefunden).',
    );
  }

  const before = parsePptxStructure(doc.excelBuffer);
  const result = improvePptx(doc.excelBuffer, ops);

  // Verification: same pre-delivery lint as generated decks. For foreign decks
  // only NEW hard problems block — the client's own pre-existing layout is not
  // ours to police, so we compare against the original's lint.
  const lintBefore = lintDeckBuffer(doc.excelBuffer);
  const lintAfter = lintDeckBuffer(result.buffer);
  if (lintAfter.hard > lintBefore.hard) {
    console.error(JSON.stringify({ event: 'improve_deck_lint_blocked', before: lintBefore.hard, after: lintAfter.hard, violations: lintAfter.violations.slice(0, 5) }));
    throw new Error('Die verbesserte Präsentation hat die Strukturprüfung nicht bestanden — Original bleibt unverändert erhalten.');
  }

  const filename = doc.filename.replace(/\.pptx$/i, '') + ' — AEGIS-verbessert.pptx';
  const downloadId = await storeDocument(
    {
      filename,
      type: 'deck',
      textContent: `Improved uploaded deck (${before.slideCount} → ${result.slideCount} slides, ${result.replacements} corrections) · original preserved as ${deckDocumentId}`,
      excelBuffer: result.buffer,
    },
    sessionId,
  );

  console.info(
    JSON.stringify({
      event: 'improve_uploaded_deck',
      replacements: result.replacements,
      appendedSlides: result.appendedSlides,
      slides: result.slideCount,
      skipped: skippedCorrections.length,
      bytes: result.buffer.length,
      durationMs: Date.now() - startedAt,
    }),
  );

  return {
    downloadId,
    filename,
    replacements: result.replacements,
    appendedSlides: result.appendedSlides,
    slideCount: result.slideCount,
    skippedCorrections,
  };
}

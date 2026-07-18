import type Anthropic from '@anthropic-ai/sdk';
import mammoth from 'mammoth';
import { KB } from '@/lib/kb';
import { getDocument, storeDocument } from '../document-store';
import { getSavedFindings } from '../findings-store';
import { buildRecommendation, deriveSeverity } from '../gap-finding';
import { improveDocx, type DocxImproveOp, type DocxReplaceOp } from '../export/docx-improve';
import {
  buildChangeLogDocx,
  buildImprovedTextDocx,
  type ChangeLogEntry,
} from '../export/changelog';
import type { ToolContext } from '../types';

/**
 * improve_document — produce an IMPROVED VERSION of an uploaded policy plus a
 * transparent Änderungsprotokoll, without ever touching the original
 * (review 2026-07, DOC-3).
 *
 * Format matrix:
 *  - DOCX  → surgical OOXML patch of a COPY (formatting preserved);
 *  - PDF   → improved version as a NEW document (PDFs are not editable in
 *            place — stated honestly in the deliverable);
 *  - PPTX  → handled by improve_uploaded_deck (this tool redirects);
 *  - XLSX  → handled by fill_template (this tool redirects).
 *
 * ANTI-HALLUCINATION CONTRACT (same as improve_uploaded_deck): the model never
 * supplies replacement regulatory prose. `corrections` pair a snippet from the
 * user's document with a KB requirement id — the replacement text is that
 * entry's German summary. The appended section is built from the document's
 * SAVED gap findings only, whose recommendations are KB-control-derived.
 * Unknown ids are dropped and reported, never invented.
 */
export const IMPROVE_DOCUMENT_SCHEMA: Anthropic.Tool = {
  name: 'improve_document',
  description:
    'Erstellt eine ÜBERARBEITETE FASSUNG einer hochgeladenen Policy (DOCX formatierungserhaltend; PDF als neues Dokument) ' +
    'plus ein transparentes Änderungsprotokoll. Das Original bleibt unverändert. ' +
    'corrections ersetzen veraltete Aussagen durch die KB-Zusammenfassung der angegebenen Requirement-ID (keine erfundenen Ersatztexte). ' +
    'appendRecommendations hängt einen klar gekennzeichneten Abschnitt mit den KB-basierten Empfehlungen der letzten Gap-Analyse an. ' +
    'Für .pptx improve_uploaded_deck verwenden, für .xlsx fill_template.',
  input_schema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'fileId der hochgeladenen Policy (aus dem Upload).',
      },
      corrections: {
        type: 'array',
        description: 'Veraltete/falsche Aussagen: exakter find-Text + KB-Requirement-ID, deren summaryDe ihn ersetzt.',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string', description: 'Exakter Text im Dokument, der ersetzt werden soll.' },
            requirementId: { type: 'string', description: 'KB-ID (z. B. "R-DORA-024").' },
          },
          required: ['find', 'requirementId'],
        },
      },
      appendRecommendations: {
        type: 'boolean',
        description: 'Abschnitt "Regulatorische Ergänzungen (AEGIS)" mit den Empfehlungen der gespeicherten Gap-Findings anhängen.',
      },
    },
    required: ['documentId'],
  },
};

export type ImproveDocumentInput = {
  documentId?: string;
  corrections?: { find: string; requirementId: string }[];
  appendRecommendations?: boolean;
};

export type ImproveDocumentResult = {
  downloadId: string;
  filename: string;
  changeLogDownloadId: string;
  changeLogFilename: string;
  replacements: number;
  appendedRecommendations: number;
  skippedCorrections: string[];
  /** Structured list for the client's attachment rendering. */
  attachments: { downloadId: string; filename: string }[];
  note: string;
};

const APPEND_CAP = 10;

function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export async function executeImproveDocument(
  input: unknown,
  ctx: ToolContext = { sessionId: null },
): Promise<ImproveDocumentResult> {
  const { documentId, corrections, appendRecommendations } = (input ?? {}) as ImproveDocumentInput;
  const sessionId = ctx.sessionId;
  if (!sessionId) throw new Error('Keine Session — bitte zuerst ein Dokument hochladen.');
  if (!documentId) throw new Error('documentId fehlt — welches hochgeladene Dokument soll überarbeitet werden?');

  const doc = await getDocument(documentId, sessionId);
  if (!doc) throw new Error('Das angegebene Dokument wurde nicht gefunden (oder gehört zu einer anderen Session).');

  const ext = extOf(doc.filename);
  if (ext === 'pptx') {
    throw new Error('Für Präsentationen bitte improve_uploaded_deck verwenden — es erhält das Folien-Design.');
  }
  if (ext === 'xlsx') {
    throw new Error('Für Excel-Arbeitsmappen bitte fill_template verwenden — es erhält Formeln und Formatierung.');
  }
  if (ext !== 'docx' && ext !== 'pdf' && ext !== 'txt' && ext !== 'md' && ext !== 'markdown') {
    throw new Error(`Dateityp .${ext} wird für die Überarbeitung nicht unterstützt (DOCX, PDF oder Text).`);
  }

  const startedAt = Date.now();

  // Resolve corrections through the KB — the only permitted source of
  // replacement prose. Unknown ids → skipped, reported, never invented.
  const skippedCorrections: string[] = [];
  const resolved: { find: string; replace: string; reqId: string; severity: string }[] = [];
  for (const c of corrections ?? []) {
    const req = c.find?.trim() ? KB.byId(c.requirementId) : null;
    const replacement = req ? (req.summaryDe?.trim() || req.summary?.trim()) : undefined;
    if (!req || !replacement) {
      skippedCorrections.push(c.requirementId ?? '(ohne ID)');
      continue;
    }
    resolved.push({
      find: c.find,
      replace: `${replacement} [${req.id}]`,
      reqId: req.id,
      severity: deriveSeverity(req),
    });
  }

  // Appended recommendations come from the document's SAVED findings only.
  let appendix: { heading: string; paragraphs: string[]; entries: ChangeLogEntry[] } | null = null;
  if (appendRecommendations) {
    const findings = (await getSavedFindings(sessionId, documentId)) ?? [];
    if (findings.length === 0) {
      throw new Error(
        'Keine gespeicherten Gap-Findings für dieses Dokument — bitte zuerst analyze_document ausführen, dann erneut überarbeiten.',
      );
    }
    const top = findings.slice(0, APPEND_CAP);
    const paragraphs = top.map((f) => {
      const req = KB.byId(f.requirementId);
      const rec = req ? buildRecommendation(req) : f.recommendation;
      return `${f.requirementId} · ${f.regulation} ${f.article} — ${f.requirementTitle}: ${rec}`;
    });
    if (findings.length > APPEND_CAP) {
      paragraphs.push(`Hinweis: ${findings.length - APPEND_CAP} weitere Findings im vollständigen AEGIS-Export.`);
    }
    appendix = {
      heading: 'Regulatorische Ergänzungen (AEGIS)',
      paragraphs,
      entries: top.map((f) => ({
        location: 'Anhang',
        before: '',
        after: `${f.requirementId} — ${f.requirementTitle}`,
        basis: f.requirementId,
        rationale: `Gap-Finding (${f.status}), Schweregrad ${f.severity} — KB-basierte Empfehlung ergänzt.`,
      })),
    };
  }

  if (resolved.length === 0 && !appendix) {
    throw new Error(
      skippedCorrections.length > 0
        ? `Keine der angegebenen Requirement-IDs war in der Wissensbasis auflösbar (${skippedCorrections.join(', ')}) — nichts geändert.`
        : 'Keine anwendbaren Änderungen angegeben (corrections leer, appendRecommendations nicht gesetzt).',
    );
  }

  const changeEntries: ChangeLogEntry[] = [];
  let improvedBuffer: Buffer;
  let improvedFilename: string;
  let replacements = 0;
  let note: string;

  if (ext === 'docx') {
    if (!doc.excelBuffer) {
      throw new Error(
        'Für diese Datei liegt kein Original-DOCX mehr vor. Bitte das Dokument erneut hochladen — dann ist die formatierungserhaltende Überarbeitung möglich.',
      );
    }
    const ops: DocxImproveOp[] = resolved.map<DocxImproveOp>((r) => ({
      type: 'replaceText',
      find: r.find,
      replace: r.replace,
    }));
    if (appendix) ops.push({ type: 'appendSection', heading: appendix.heading, paragraphs: appendix.paragraphs });

    const result = improveDocx(doc.excelBuffer, ops);
    replacements = result.replacements;
    for (const s of result.skipped) {
      const r = resolved.find((x) => x.find === (s as DocxReplaceOp).find);
      skippedCorrections.push(r ? `${r.reqId} (Text nicht gefunden)` : '(Text nicht gefunden)');
    }
    for (const r of resolved) {
      if (!result.skipped.some((s) => s.find === r.find)) {
        changeEntries.push({
          location: 'Dokumenttext',
          before: r.find,
          after: r.replace,
          basis: r.reqId,
          rationale: `Aussage an die verifizierte KB-Fassung angepasst (Schweregrad ${r.severity}).`,
        });
      }
    }
    if (appendix) changeEntries.push(...appendix.entries);

    // Verification before delivery: re-extract the improved copy and assert
    // every applied change is really present. Failure → nothing delivered.
    const reExtracted = (await mammoth.extractRawText({ buffer: result.buffer })).value.replace(/\s+/g, ' ');
    for (const e of changeEntries) {
      // Text replacements must appear verbatim; appendix entries are asserted
      // via their requirement id (the paragraph adds article/recommendation
      // around it) plus the section heading below.
      const probe =
        e.location === 'Anhang' ? e.basis : e.after.replace(/\s+/g, ' ').slice(0, 120);
      if (!reExtracted.includes(probe)) {
        throw new Error('Die überarbeitete Fassung hat die Prüfung nicht bestanden — Original bleibt unverändert.');
      }
    }
    if (appendix && !reExtracted.includes(appendix.heading)) {
      throw new Error('Die überarbeitete Fassung hat die Prüfung nicht bestanden — Original bleibt unverändert.');
    }

    improvedBuffer = result.buffer;
    improvedFilename = doc.filename.replace(/\.docx$/i, '') + ' — AEGIS-überarbeitet.docx';
    note = 'DOCX formatierungserhaltend überarbeitet; Original unverändert.';
  } else {
    // PDF / text: improved version as a NEW document (honest limitation).
    const sourceParagraphs = doc.textContent.split(/\n{2,}|\r\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim());
    let corrected = sourceParagraphs;
    for (const r of resolved) {
      let found = false;
      corrected = corrected.map((p) => {
        if (p.includes(r.find)) {
          found = true;
          return p.split(r.find).join(r.replace);
        }
        return p;
      });
      if (found) {
        replacements++;
        changeEntries.push({
          location: 'Dokumenttext',
          before: r.find,
          after: r.replace,
          basis: r.reqId,
          rationale: `Aussage an die verifizierte KB-Fassung angepasst (Schweregrad ${r.severity}).`,
        });
      } else {
        skippedCorrections.push(`${r.reqId} (Text nicht gefunden)`);
      }
    }
    if (appendix) changeEntries.push(...appendix.entries);
    if (changeEntries.length === 0) {
      throw new Error('Keine der Korrekturen war im Dokumenttext auffindbar — nichts geändert.');
    }

    improvedBuffer = await buildImprovedTextDocx({
      sourceFilename: doc.filename,
      paragraphs: corrected,
      appendix: appendix ? { heading: appendix.heading, paragraphs: appendix.paragraphs } : undefined,
      date: new Date(),
    });
    improvedFilename = doc.filename.replace(/\.[^.]+$/, '') + ' — AEGIS-überarbeitet.docx';
    note =
      ext === 'pdf'
        ? 'PDF kann nicht layouterhaltend bearbeitet werden — überarbeitete Fassung als neues Dokument; Original unverändert.'
        : 'Überarbeitete Fassung als neues Dokument; Original unverändert.';
  }

  const changeLogFilename = doc.filename.replace(/\.[^.]+$/, '') + ' — Änderungsprotokoll.docx';
  const changeLogBuffer = await buildChangeLogDocx(changeEntries, {
    sourceFilename: doc.filename,
    improvedFilename,
    date: new Date(),
  });

  const downloadId = await storeDocument(
    {
      filename: improvedFilename,
      type: 'export',
      textContent: `Improved version of ${documentId} (${replacements} corrections, ${appendix ? appendix.paragraphs.length : 0} appended) · original preserved`,
      excelBuffer: improvedBuffer,
    },
    sessionId,
  );
  const changeLogDownloadId = await storeDocument(
    {
      filename: changeLogFilename,
      type: 'export',
      textContent: `Change log for ${improvedFilename} (${changeEntries.length} entries)`,
      excelBuffer: changeLogBuffer,
    },
    sessionId,
  );

  console.info(
    JSON.stringify({
      event: 'improve_document',
      format: ext,
      replacements,
      appended: appendix ? appendix.paragraphs.length : 0,
      changeLogEntries: changeEntries.length,
      skipped: skippedCorrections.length,
      durationMs: Date.now() - startedAt,
    }),
  );

  return {
    downloadId,
    filename: improvedFilename,
    changeLogDownloadId,
    changeLogFilename,
    replacements,
    appendedRecommendations: appendix ? appendix.paragraphs.length : 0,
    skippedCorrections,
    attachments: [
      { downloadId, filename: improvedFilename },
      { downloadId: changeLogDownloadId, filename: changeLogFilename },
    ],
    note,
  };
}

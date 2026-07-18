import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { db } from '@/lib/db';
import { buildMarkdown, type ProvenanceMeta } from '@/lib/regulatory/ingest';
import type { Jurisdiction } from '@/lib/regulatory/types';
import { SOURCE_FILES } from '@/lib/library/sources';
import { detectLanguage, translateText } from './deepl';
import { reviewTranslation } from './quality';

// Bundled legislation (docs/source/*.txt) can also be translated. We mark such
// translation rows with originalDocumentId = "bundled:<slug>" so the same run
// path serves both ingested docs and bundled source files.
const BUNDLED_PREFIX = 'bundled:';
const SOURCE_DIR = path.resolve(process.cwd(), 'docs', 'source');

/** Read + lightly clean a bundled source file's raw text (path-safe). */
function getBundledSourceText(slug: string): string {
  const s = SOURCE_FILES[slug];
  if (!s) return '';
  const full = path.resolve(SOURCE_DIR, s.file);
  if (full !== SOURCE_DIR && !full.startsWith(SOURCE_DIR + path.sep)) return '';
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    return '';
  }
  // Drop extractor artifacts ([SOURCE_FILE: …], dotted TOC, bare page numbers)
  // so we don't waste DeepL characters translating noise.
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^\[[A-Z][A-Z0-9_]*:[^\]]*\]\s*$/.test(t)) return false;
      if (/\.{6,}/.test(t)) return false;
      if (/^\d+\s*$/.test(t)) return false;
      return true;
    })
    .join('\n');
}

/**
 * AEGIS Translate — RegulatoryDocument (library / radar) flow.
 *
 * A translation is a NEW RegulatoryDocument row that reuses the ingestion
 * `status` lifecycle (INGESTING→INGESTED) so it appears in the Bibliothek and
 * is searched by `search_ingested_documents` automatically. It is ALWAYS
 * machine-translated (never curated KB). Idempotent per (originalId, target).
 */

const LANG_LABEL: Record<string, string> = {
  DE: 'Deutsch', EN: 'Englisch', ES: 'Spanisch', FR: 'Französisch', IT: 'Italienisch',
  NL: 'Niederländisch', PL: 'Polnisch', PT: 'Portugiesisch', CS: 'Tschechisch', SK: 'Slowakisch',
  SL: 'Slowenisch', HR: 'Kroatisch', RO: 'Rumänisch', BG: 'Bulgarisch', HU: 'Ungarisch',
  EL: 'Griechisch', DA: 'Dänisch', SV: 'Schwedisch', FI: 'Finnisch', ET: 'Estnisch',
  LT: 'Litauisch', LV: 'Lettisch', TR: 'Türkisch', UK: 'Ukrainisch', RU: 'Russisch',
  JA: 'Japanisch', KO: 'Koreanisch', ZH: 'Chinesisch', ID: 'Indonesisch', NB: 'Norwegisch',
};

export function langLabel(code: string | null | undefined): string {
  if (!code) return 'unbekannt';
  return LANG_LABEL[code.toUpperCase()] ?? code.toUpperCase();
}

/** The machine-translated provenance note for the markdown header. */
export function machineTranslatedNote(from: string | null, to: string): string {
  return `Maschinell übersetzt mit DeepL (${langLabel(from)} → ${langLabel(to)}) – nicht Teil der kuratierten Wissensbasis.`;
}

export type TranslationJob = { documentId: string; status: string; alreadyExisted: boolean };

/**
 * Create (or return the existing) translation row for a source RegulatoryDocument.
 * Idempotent: a second call for the same (source, target) returns the same row.
 */
export async function createRegulatoryTranslationJob(
  originalId: string,
  target: string,
  translatedBy: string,
): Promise<TranslationJob> {
  const original = await db.regulatoryDocument.findUnique({ where: { id: originalId } });
  if (!original) throw new Error('translation_source_not_found');
  if (original.isTranslation) throw new Error('cannot_translate_a_translation');

  const existing = await db.regulatoryDocument.findFirst({
    where: { originalDocumentId: originalId, targetLanguage: target },
  });
  if (existing) return { documentId: existing.id, status: existing.status, alreadyExisted: true };

  const row = await db.regulatoryDocument.create({
    data: {
      suggestionId: original.suggestionId,
      sourceName: original.sourceName,
      sourceUrl: original.sourceUrl,
      documentUrl: original.documentUrl,
      regulation: original.regulation,
      title: `${original.title} (${target})`,
      jurisdiction: original.jurisdiction,
      status: 'INGESTING',
      dedupeKey: `translate:${originalId}:${target}`,
      isTranslation: true,
      originalDocumentId: originalId,
      targetLanguage: target,
      translationProvider: 'DeepL',
      translationStatus: 'TRANSLATING',
      translatedBy,
    },
  });
  return { documentId: row.id, status: row.status, alreadyExisted: false };
}

/**
 * Create (or return the existing) translation row for a BUNDLED library law
 * (docs/source/*.txt). Idempotent per (slug, target).
 */
export async function createBundledTranslationJob(
  slug: string,
  target: string,
  translatedBy: string,
): Promise<TranslationJob> {
  const law = SOURCE_FILES[slug];
  if (!law) throw new Error('translation_source_not_found');

  const originalRef = `${BUNDLED_PREFIX}${slug}`;
  const existing = await db.regulatoryDocument.findFirst({
    where: { originalDocumentId: originalRef, targetLanguage: target },
  });
  if (existing) return { documentId: existing.id, status: existing.status, alreadyExisted: true };

  const row = await db.regulatoryDocument.create({
    data: {
      sourceName: 'RegCompass Bibliothek',
      sourceUrl: law.sourceUrl ?? 'https://regcompass.app/library',
      regulation: law.regulationId,
      title: `${law.title} (${target})`,
      jurisdiction: law.jurisdiction as Jurisdiction,
      status: 'INGESTING',
      dedupeKey: `translate:${originalRef}:${target}`,
      isTranslation: true,
      originalDocumentId: originalRef,
      originalLanguage: 'DE', // bundled source texts are German
      targetLanguage: target,
      translationProvider: 'DeepL',
      translationStatus: 'TRANSLATING',
      translatedBy,
    },
  });
  return { documentId: row.id, status: row.status, alreadyExisted: false };
}

/**
 * Run (or re-run) the translation for a translation row. Handles both ingested
 * sources (originalDocumentId = a RegulatoryDocument id) and bundled library
 * laws (originalDocumentId = "bundled:<slug>"). Never throws — failures are
 * persisted as status=FAILED so the UI can retry.
 */
export async function runRegulatoryTranslation(documentId: string, target: string): Promise<void> {
  const row = await db.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!row || !row.originalDocumentId) return;

  const isBundled = row.originalDocumentId.startsWith(BUNDLED_PREFIX);
  const original = isBundled
    ? null
    : await db.regulatoryDocument.findUnique({ where: { id: row.originalDocumentId } });
  const sourceText = isBundled
    ? getBundledSourceText(row.originalDocumentId.slice(BUNDLED_PREFIX.length))
    : original?.rawText ?? '';
  if (!sourceText.trim()) {
    await db.regulatoryDocument.update({
      where: { id: documentId },
      data: { status: 'FAILED', translationStatus: 'FAILED', error: 'translation_source_empty' },
    });
    return;
  }

  try {
    const { text: translated, detectedSourceLang } = await translateText(sourceText, target);
    const fromLang = original?.originalLanguage ?? detectedSourceLang;
    const warnings = reviewTranslation(sourceText, translated, fromLang, target);

    const meta: ProvenanceMeta = {
      title: row.title,
      sourceName: row.sourceName,
      sourceUrl: row.sourceUrl,
      documentUrl: row.documentUrl,
      regulation: row.regulation,
      jurisdiction: row.jurisdiction as Jurisdiction,
    };
    const markdown = buildMarkdown(meta, translated, machineTranslatedNote(fromLang, target), [
      `**Übersetzung:** ${langLabel(fromLang)} → ${langLabel(target)} · DeepL`,
    ]);

    await db.regulatoryDocument.update({
      where: { id: documentId },
      data: {
        rawText: translated,
        markdown,
        byteSize: Buffer.byteLength(translated, 'utf8'),
        status: 'INGESTED',
        translationStatus: 'TRANSLATED',
        translatedAt: new Date(),
        originalLanguage: fromLang,
        qualityWarnings: warnings,
        fetchedAt: new Date(),
        error: null,
      },
    });

    // Backfill the source's detected language while we have it (cheap, once).
    if (original && !original.originalLanguage && fromLang) {
      await db.regulatoryDocument
        .update({ where: { id: original.id }, data: { originalLanguage: fromLang } })
        .catch(() => {});
    }
  } catch (err) {
    await db.regulatoryDocument
      .update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          translationStatus: 'FAILED',
          error: err instanceof Error ? err.message.slice(0, 500) : 'translation_failed',
        },
      })
      .catch(() => {});
  }
}

/** Detect + cache the source language on a RegulatoryDocument (lazy backfill). */
export async function detectRegulatoryLanguage(documentId: string): Promise<string | null> {
  const doc = await db.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!doc) return null;
  if (doc.originalLanguage) return doc.originalLanguage;
  const text = doc.rawText ?? doc.markdown ?? '';
  if (!text.trim()) return null;
  const lang = await detectLanguage(text);
  if (lang) await db.regulatoryDocument.update({ where: { id: documentId }, data: { originalLanguage: lang } }).catch(() => {});
  return lang;
}

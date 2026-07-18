import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SOURCE_FILES } from '@/lib/library/sources';
import { parseToTree } from '@/lib/library/parser';
import type { SourceFile } from '@/lib/library/types';
import { db } from '@/lib/db';

const ALLOWED_DIR = path.resolve(process.cwd(), 'docs/source');

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const source = SOURCE_FILES[slug];
  if (!source) {
    // Not a bundled source file → try a radar-ingested document (by id).
    return loadIngestedDocument(slug);
  }

  const filePath = path.resolve(ALLOWED_DIR, source.file);
  if (!filePath.startsWith(ALLOWED_DIR)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Path traversal denied.' },
      { status: 403 },
    );
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const tree = parseToTree(content, source.regulationId, source.format);
    return NextResponse.json({ source, tree });
  } catch {
    return NextResponse.json(
      { error: 'not_found', message: `Source file not found: ${source.file}` },
      { status: 404 },
    );
  }
}

/**
 * Render a radar-ingested document (stored in Postgres, not on disk). The
 * converted plaintext is parsed with the generic `fallback` format so it shows
 * in the EUR-Lex-style reader without bespoke structure detection.
 */
async function loadIngestedDocument(id: string) {
  let doc;
  try {
    doc = await db.regulatoryDocument.findUnique({ where: { id } });
  } catch {
    doc = null;
  }
  if (!doc || doc.status !== 'INGESTED' || !doc.rawText) {
    return NextResponse.json({ error: 'not_found', message: `Unknown document: ${id}` }, { status: 404 });
  }
  const source: SourceFile & { ingested: true } = {
    regulationId: doc.id,
    file: '',
    title: doc.title,
    fullTitle: `${doc.regulation} — ${doc.sourceName}`,
    jurisdiction: doc.jurisdiction as SourceFile['jurisdiction'],
    format: 'fallback',
    sourceUrl: doc.documentUrl ?? doc.sourceUrl,
    ingested: true,
    originalLanguage: doc.originalLanguage,
    isTranslation: doc.isTranslation,
    originalDocumentId: doc.originalDocumentId,
  };
  const tree = parseToTree(doc.rawText, doc.id, 'fallback');
  return NextResponse.json({ source, tree });
}

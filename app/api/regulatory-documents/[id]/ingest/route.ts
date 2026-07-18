import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import {
  convertFromBuffer,
  persistResult,
  runIngestion,
  type ProvenanceMeta,
} from '@/lib/regulatory/ingest';
import type { Jurisdiction } from '@/lib/regulatory/types';

export const maxDuration = 60;

/**
 * Admin-only: (re-)ingest a regulatory document. Two modes:
 *  - multipart/form-data with a `file` field → convert an uploaded PDF/DOCX/TXT/MD
 *    (manual fallback when auto-fetch could not resolve a clean document).
 *  - JSON `{ documentUrl? }` → set a direct document link (optional) and re-run
 *    the fetch+convert pipeline (retry).
 *
 * Never promotes anything into the curated KB — only updates the runtime
 * RegulatoryDocument row.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromCookies();
  if (!requireAdmin(user)) {
    return NextResponse.json({ error: 'forbidden', message: 'Nur für Admins.' }, { status: 403 });
  }

  const { id } = await params;
  const doc = await db.regulatoryDocument.findUnique({ where: { id } });
  if (!doc) {
    return NextResponse.json({ error: 'not_found', message: 'Dokument nicht gefunden.' }, { status: 404 });
  }

  const contentType = req.headers.get('content-type') ?? '';

  // ── Manual upload path ──
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: 'invalid_input', message: 'Ungültiges Formular.' }, { status: 400 });
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'invalid_input', message: 'Datei fehlt.' }, { status: 400 });
    }
    const meta: ProvenanceMeta = {
      title: doc.title,
      sourceName: doc.sourceName,
      sourceUrl: doc.documentUrl ?? doc.sourceUrl,
      documentUrl: doc.documentUrl,
      regulation: doc.regulation,
      jurisdiction: doc.jurisdiction as Jurisdiction,
    };
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await convertFromBuffer(meta, buffer, file.name);
    await persistResult(id, result);
    const updated = await db.regulatoryDocument.findUnique({ where: { id } });
    return NextResponse.json({ document: publicDoc(updated) });
  }

  // ── Retry / direct-link path ──
  let body: { documentUrl?: string } = {};
  try {
    body = (await req.json()) as { documentUrl?: string };
  } catch {
    /* empty body → plain retry */
  }
  if (body.documentUrl) {
    let parsed: string;
    try {
      parsed = new URL(body.documentUrl).toString();
    } catch {
      return NextResponse.json({ error: 'invalid_input', message: 'Ungültige URL.' }, { status: 400 });
    }
    await db.regulatoryDocument.update({ where: { id }, data: { documentUrl: parsed } });
  }
  await runIngestion(id);
  const updated = await db.regulatoryDocument.findUnique({ where: { id } });
  return NextResponse.json({ document: publicDoc(updated) });
}

function publicDoc(d: Awaited<ReturnType<typeof db.regulatoryDocument.findUnique>>) {
  if (!d) return null;
  return {
    id: d.id,
    title: d.title,
    regulation: d.regulation,
    status: d.status,
    error: d.error,
    documentUrl: d.documentUrl,
    sourceUrl: d.sourceUrl,
  };
}

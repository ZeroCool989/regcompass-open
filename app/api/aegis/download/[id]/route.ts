import { NextResponse, type NextRequest } from 'next/server';
import { getDocument } from '@/lib/aegis/document-store';
import { readSessionId } from '@/lib/session';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Scoped to the requesting session: a document id from another session
  // resolves to nothing (404, indistinguishable from a non-existent id).
  const sessionId = readSessionId(req);
  const doc = await getDocument(id, sessionId);
  if (!doc) {
    return NextResponse.json({ error: 'not_found', message: 'Dokument nicht gefunden oder abgelaufen — bitte den Export erneut erzeugen.' }, { status: 404 });
  }

  // Text download (?format=txt|md) — used by AEGIS Translate to download a
  // translated working document's text. Falls back to the Excel binary path.
  const format = new URL(req.url).searchParams.get('format');
  if (format === 'txt' || format === 'md') {
    const safeName = doc.filename.replace(/\.[^.]+$/, '').replace(/["\r\n]/g, '');
    const ext = format === 'md' ? 'md' : 'txt';
    const mime = format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
    const body = doc.textContent ?? '';
    return new Response(body, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${safeName}.${ext}"`,
      },
    });
  }

  if (!doc.excelBuffer) {
    return NextResponse.json(
      { error: 'not_found', message: 'Dokument nicht gefunden oder ohne herunterladbare Datei — bitte den Export erneut erzeugen.' },
      { status: 404 },
    );
  }

  // Pick the MIME type by file extension so the same binary path serves both
  // the Excel gap report (.xlsx) and the PPTX management summary (.pptx).
  const ext = (doc.filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'xlsx').toLowerCase();
  const MIME: Record<string, string> = {
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
  };
  const contentType = MIME[ext] ?? 'application/octet-stream';

  return new Response(new Uint8Array(doc.excelBuffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${doc.filename.replace(/["\r\n]/g, '')}"`,
      'Content-Length': String(doc.excelBuffer.length),
    },
  });
}

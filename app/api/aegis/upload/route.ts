import { NextResponse, type NextRequest } from 'next/server';
import { capText, parsePDF, parseDOCX, parseExcelToSheets, parsePPTX } from '@/lib/aegis/parsers';
import { storeDocument } from '@/lib/aegis/document-store';
import { db } from '@/lib/db';
import { detectLanguage, isTranslationConfigured } from '@/lib/translate/deepl';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { getUserFromRequest, isApproved, requireAdmin } from '@/lib/auth';
import {
  SESSION_COOKIE,
  createSession,
  readSessionId,
  sessionCookieOptions,
} from '@/lib/session';

// Vercel serverless functions reject request bodies above ~4.5 MB before the
// route ever runs — a nominal 10 MB limit here was a lie users hit as an
// opaque platform error. 4 MB is the honest, actually-reachable ceiling; the
// error message names it so users know to split/compress larger documents.
const MAX_SIZE = 4 * 1024 * 1024;

// Minimum non-whitespace characters the extraction must yield for a policy
// upload to be analyzable. A scanned/image-only PDF parses without error but
// produces (near-)zero text — analyzing it would fabricate findings about a
// document the system never read (finding DOC-1, review 2026-07).
export const MIN_EXTRACTABLE_CHARS = 50;

const uploadLimiter = rateLimit({
  key: 'aegis-upload',
  limit: 20,
  windowMs: 60 * 60 * 1000,
});

// Legacy .xls (CFB container) is intentionally NOT supported — the exceljs
// parser only reads OOXML (.xlsx), and the old binary format has a much
// larger attack surface.
type DocFormat = 'pdf' | 'docx' | 'excel' | 'pptx' | 'text';

const MIME_HANDLERS: Record<string, DocFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'text',
  // Markdown is plain UTF-8 text — route it through the same text path as .txt.
  'text/markdown': 'text',
  'text/x-markdown': 'text',
};

/**
 * Build a safe, short parse-error detail for development responses: error name
 * plus the first line of the message only. Never includes the stack trace or
 * any file content, and is capped so a verbose library message can't bloat the
 * response. Production callers must NOT receive this.
 */
function safeParseErrorDetail(err: unknown): string {
  const name = err instanceof Error && err.name ? err.name : 'Error';
  const rawMessage = err instanceof Error ? err.message : String(err);
  const firstLine = rawMessage.split('\n')[0]?.trim().slice(0, 200) ?? '';
  return firstLine ? `${name}: ${firstLine}` : name;
}

export function detectFormat(mime: string, filename: string): DocFormat | null {
  const byMime = MIME_HANDLERS[mime];
  if (byMime) return byMime;
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'excel';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'txt') return 'text';
  if (ext === 'md' || ext === 'markdown') return 'text';
  return null;
}

/**
 * Validate the file's leading bytes against the claimed format. MIME type and
 * filename are client-controlled; the magic bytes are the first thing the
 * parsers will actually choke on, so reject mismatches before parsing.
 */
export function magicBytesOk(format: DocFormat, buf: Buffer): boolean {
  switch (format) {
    case 'pdf':
      return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'docx':
    case 'excel':
    case 'pptx':
      // OOXML files (incl. PowerPoint) are ZIP containers.
      return (
        buf.length >= 4 &&
        buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
      );
    case 'text':
      // No signature — reject anything with NUL bytes in the first KiB
      // (binary masquerading as text).
      return !buf.subarray(0, 1024).includes(0);
  }
}

export async function POST(req: NextRequest) {
  const limit = await uploadLimiter.check(ipHash(req));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Upload-Limit erreicht (20 pro Stunde). Bitte später erneut versuchen.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Uploads feed AEGIS (gap analysis / Claude) — gate behind approval too.
  const uploader = await getUserFromRequest(req);
  const isAdmin = requireAdmin(uploader);
  if (!isApproved(uploader)) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  // Documents are owned by the uploading session. Normally the cookie already
  // exists (proxy.ts sets it on page load); if this is a cold API call,
  // mint a session here and attach the cookie to the response.
  let sessionId = readSessionId(req);
  let newSessionValue: string | null = null;
  if (!sessionId) {
    const session = createSession();
    sessionId = session.id;
    newSessionValue = session.value;
  }
  const respond = (payload: unknown, init?: { status?: number }) => {
    const res = NextResponse.json(payload, init);
    if (newSessionValue) {
      res.cookies.set(SESSION_COOKIE, newSessionValue, sessionCookieOptions());
    }
    return res;
  };

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return respond(
      { error: 'invalid_input', message: 'Die Anfrage muss als multipart/form-data gesendet werden.' },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return respond(
      { error: 'invalid_input', message: 'Es wurde keine Datei übermittelt.' },
      { status: 400 },
    );
  }

  const docType = (formData.get('type') as string) ?? 'policy';
  if (docType !== 'policy' && docType !== 'template') {
    return respond(
      { error: 'invalid_input', message: 'Ungültiger Upload-Typ — erwartet wird "policy" oder "template".' },
      { status: 400 },
    );
  }

  if (file.size > MAX_SIZE) {
    return respond(
      {
        error: 'invalid_input',
        message:
          `Die Datei überschreitet das Upload-Limit von ${MAX_SIZE / 1024 / 1024} MB (Plattform-Grenze). ` +
          'Bitte das Dokument aufteilen oder komprimieren (z. B. Bilder entfernen) und erneut hochladen.',
      },
      { status: 400 },
    );
  }

  const format = detectFormat(file.type, file.name);
  if (!format) {
    return respond(
      { error: 'invalid_input', message: 'Nicht unterstütztes Dateiformat. Bitte PDF, DOCX, PPTX, XLSX oder TXT verwenden.' },
      { status: 400 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!magicBytesOk(format, buffer)) {
    return respond(
      {
        error: 'invalid_input',
        message: 'Der Dateiinhalt entspricht nicht dem angegebenen Dateityp.',
      },
      { status: 400 },
    );
  }

  const parseStartedAt = Date.now();
  try {
    if (docType === 'template' && format === 'excel') {
      const excelData = await parseExcelToSheets(buffer);
      const textContent = excelData.sheets
        .map((s) => `[${s.name}] ${s.headers.join(', ')}`)
        .join('\n');

      const fileId = await storeDocument(
        {
          filename: file.name,
          type: 'template',
          textContent,
          excelData,
          excelBuffer: buffer,
        },
        sessionId,
      );

      return respond({
        fileId,
        filename: file.name,
        type: 'template',
        textContent,
        sheets: excelData.sheets.map((s) => ({
          name: s.name,
          headers: s.headers,
          rowCount: s.rows.length,
        })),
      });
    }

    let rawText: string;
    if (format === 'pdf') {
      rawText = await parsePDF(buffer);
    } else if (format === 'docx') {
      rawText = await parseDOCX(buffer);
    } else if (format === 'pptx') {
      rawText = await parsePPTX(buffer);
    } else if (format === 'excel') {
      const excelData = await parseExcelToSheets(buffer);
      // Sheet/header markers keep tabular context readable for the analysis.
      rawText = excelData.sheets
        .map((s) => `[Blatt: ${s.name}]\n${s.headers.join(' | ')}\n${s.rows.map((r) => Object.values(r).join(' | ')).join('\n')}`)
        .join('\n\n');
    } else {
      rawText = new TextDecoder().decode(buffer);
    }
    // Full text is stored and analyzed. Only the 2M-char safety ceiling can cut
    // it — and that is reported explicitly, never silent (DOC-2).
    const parsed = capText(rawText);
    const textContent = parsed.text;

    // Zero-/low-text guard for binary containers: a scanned/image-only PDF
    // (or an all-images DOCX/PPTX) parses without error but extraction yields
    // (near-)nothing. Reject before storing — analyzing it would fabricate
    // findings. Plain-text uploads are exempt: their content IS the text the
    // user provided, however short. Telemetry first, so the scanned-PDF
    // signal stays visible in logs.
    const meaningfulChars = textContent.replace(/\s+/g, '').length;
    if (format !== 'text' && meaningfulChars < MIN_EXTRACTABLE_CHARS) {
      console.info(
        JSON.stringify({
          event: 'upload_rejected_no_text',
          format,
          fileBytes: buffer.length,
          textChars: textContent.length,
          durationMs: Date.now() - parseStartedAt,
        }),
      );
      return respond(
        {
          error: 'no_extractable_text',
          message:
            'Kein auswertbarer Text im Dokument gefunden — vermutlich ein gescanntes bzw. Bild-PDF. Bitte laden Sie eine Version mit auswählbarem Text hoch (OCR erforderlich).',
        },
        { status: 422 },
      );
    }

    const fileId = await storeDocument(
      {
        filename: file.name,
        type: 'policy',
        textContent,
        // All binary policy uploads keep their original bytes (immutable
        // original): PPTX for design-preserving deck improvement, DOCX for
        // formatting-preserving document improvement, PDF/XLSX so the source
        // of a finding can always be re-examined (DOC-4 prerequisite).
        ...(format !== 'text' ? { excelBuffer: buffer } : {}),
      },
      sessionId,
    );

    // AEGIS Translate: detect the document language so the client can offer a
    // pre-analysis translation when it isn't German/English. ADMIN-ONLY (matches
    // the translation capability). Best-effort: never fail the upload, no-op
    // when DeepL is not configured.
    let originalLanguage: string | null = null;
    if (isAdmin && isTranslationConfigured() && textContent.trim()) {
      try {
        originalLanguage = await detectLanguage(textContent);
        if (originalLanguage) {
          await db.aegisDocument.update({ where: { id: fileId }, data: { originalLanguage } });
        }
      } catch {
        /* detection is optional */
      }
    }

    // Telemetry: extraction time + how much text we got (0 chars ⇒ a scanned /
    // image-only PDF that parsed without error but yields nothing to analyze).
    console.info(
      JSON.stringify({
        event: 'upload_parse',
        format,
        fileBytes: buffer.length,
        textChars: textContent.length,
        durationMs: Date.now() - parseStartedAt,
      }),
    );

    return respond({
      fileId,
      filename: file.name,
      type: 'policy',
      // Response preview only — the STORED text is complete. totalChars +
      // truncated make document size honest to the client (DOC-2).
      textContent: textContent.slice(0, 100_000),
      textPreviewTruncated: textContent.length > 100_000,
      totalChars: parsed.totalChars,
      truncated: parsed.truncated,
      originalLanguage,
    });
  } catch (err) {
    // Parser internals (library names, offsets) stay in server logs.
    console.error('[aegis/upload] parse error:', err, {
      format,
      durationMs: Date.now() - parseStartedAt,
    });
    // Name the format in the client message so a PDF extraction failure reads as
    // exactly that — not a generic "document" error (and not the unrelated
    // request-timeout message the chat shows for slow analysis runs).
    const formatLabel =
      format === 'pdf' ? 'PDF'
        : format === 'docx' ? 'DOCX'
        : format === 'excel' ? 'Excel'
        : format === 'pptx' ? 'PowerPoint'
        : 'Text';
    const body: { error: string; message: string; detail?: string } = {
      error: 'parse_error',
      message: `${formatLabel}-Extraktion fehlgeschlagen — die Datei konnte nicht gelesen werden. Bitte prüfen Sie, ob es sich um ein gültiges, unbeschädigtes ${formatLabel}-Dokument handelt.`,
    };
    // In non-production, surface a safe short detail (error name + first message
    // line) so the failing parser is visible client-side while debugging. Never
    // in production — and never a stack trace or file content.
    if (process.env.NODE_ENV !== 'production') {
      body.detail = safeParseErrorDetail(err);
    }
    return respond(body, { status: 422 });
  }
}

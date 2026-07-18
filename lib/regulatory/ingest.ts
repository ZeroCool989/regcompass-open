import { NodeHtmlMarkdown } from 'node-html-markdown';
import { db } from '@/lib/db';
import { parsePDF, parseDOCX } from '@/lib/aegis/parsers';
import { detectLanguage, isTranslationConfigured } from '@/lib/translate/deepl';
import { normalizeUrl } from './dedupe';
import { OFFICIAL_SOURCES } from './sources';
import type { Jurisdiction } from './types';

/**
 * Ingestion pipeline: fetch the document behind an accepted radar suggestion,
 * convert it to plaintext + markdown, and store it as a runtime-mutable
 * RegulatoryDocument so it appears in the Bibliothek and is searchable by AEGIS
 * (always as an UNVERIFIED raw source — never promoted into the curated KB).
 *
 * The pure helpers (SSRF guard, content-type routing, PDF-link discovery,
 * markdown generation) are exported and unit-tested without network/DB.
 */

// ───────────────────────── Limits ─────────────────────────

const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_MARKDOWN_CHARS = 200_000;
const USER_AGENT =
  'RegCompass-Radar/1.0 (+https://regcompass.app; regulatory document ingestion)';

// ───────────────────────── SSRF guard ─────────────────────────

/** Registrable domain (last two labels) — coarse but safe for our official set. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  return labels.slice(-2).join('.');
}

/** Official registrable domains derived from the trusted source registry. */
const OFFICIAL_REGISTRABLES = new Set(
  OFFICIAL_SOURCES.map((s) => {
    try {
      return registrableDomain(new URL(s.url).host);
    } catch {
      return '';
    }
  }).filter(Boolean),
);

/** registrable domain → jurisdiction, derived from the trusted source registry. */
const REGISTRABLE_JURISDICTION = new Map<string, Jurisdiction>(
  OFFICIAL_SOURCES.flatMap((s) => {
    try {
      return [[registrableDomain(new URL(s.url).host), s.jurisdiction] as const];
    } catch {
      return [];
    }
  }),
);

/** Best-effort jurisdiction for a source URL (falls back to INTL). */
export function inferJurisdiction(url: string): Jurisdiction {
  try {
    return REGISTRABLE_JURISDICTION.get(registrableDomain(new URL(url).host)) ?? 'INTL';
  } catch {
    return 'INTL';
  }
}

/** True for IP-literal / loopback / bare hosts we must never fetch (SSRF). */
function isUnsafeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (!h.includes('.')) return true; // bare hostname → likely internal
  // IPv6 literal or any IPv4 literal — block outright (we only fetch named hosts).
  if (h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

/**
 * Assert a URL is safe + allowed to fetch server-side. Throws otherwise.
 * Allow = http(s), a named (non-IP) host, and a registrable domain that is
 * either an official source or the same registrable as the originating page.
 */
export function assertFetchableUrl(url: string, allowRegistrable?: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('ingest_invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('ingest_scheme_blocked');
  if (isUnsafeHost(u.host)) throw new Error('ingest_host_blocked');
  const reg = registrableDomain(u.host);
  if (!OFFICIAL_REGISTRABLES.has(reg) && reg !== allowRegistrable) {
    throw new Error('ingest_host_not_allowlisted');
  }
}

// ───────────────────────── Content-type routing ─────────────────────────

export type DocKind = 'pdf' | 'html' | 'other';

/** Decide pdf/html/other from the Content-Type header and/or magic bytes. */
export function classifyContentType(contentTypeHeader: string | null, head: Uint8Array): DocKind {
  const ct = (contentTypeHeader ?? '').toLowerCase();
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return 'html';
  // Sniff: "%PDF" magic, or an HTML doctype/tag near the start.
  const start = new TextDecoder('latin1').decode(head.slice(0, 256)).toLowerCase();
  if (start.startsWith('%pdf')) return 'pdf';
  if (start.includes('<!doctype html') || start.includes('<html')) return 'html';
  return 'other';
}

/**
 * Find the most likely primary PDF link in an HTML page. Resolves relative
 * URLs against the base. Returns absolute URL or null.
 */
export function findPrimaryPdfLink(html: string, baseUrl: string): string | null {
  const hrefs: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  for (const href of hrefs) {
    // Decode the few HTML entities that legitimately appear in href attributes
    // (e.g. `&amp;` between query params) before building the URL.
    const decoded = href.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
    const clean = decoded.split('#')[0];
    if (!/\.pdf(?:[?].*)?$/i.test(clean)) continue;
    try {
      return new URL(clean, baseUrl).toString();
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

/** Extract a human title from an HTML page's <title> (trimmed), or null. */
export function extractHtmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, ' ').trim();
  return title.length >= 3 ? title.slice(0, 240) : null;
}

// ───────────────────────── Conversion ─────────────────────────

/** Strip markdown syntax to a readable plaintext for the Bibliothek body. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // code fences
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[*_`]+/g, '') // emphasis/code marks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type ProvenanceMeta = {
  title: string;
  sourceName: string;
  sourceUrl: string;
  documentUrl?: string | null;
  regulation: string;
  jurisdiction: Jurisdiction;
};

const DEFAULT_PROVENANCE_NOTE = 'Extern eingespeist – nicht in der kuratierten Wissensbasis verifiziert.';

/**
 * Build the AEGIS-facing markdown with a provenance + unverified-source header.
 * `provenanceNote` overrides the default warning (e.g. the machine-translated
 * note used by AEGIS Translate) so both ingestion and translation share one
 * header format. `extraLines` are appended into the blockquote (e.g. languages).
 */
export function buildMarkdown(
  meta: ProvenanceMeta,
  body: string,
  provenanceNote: string = DEFAULT_PROVENANCE_NOTE,
  extraLines: string[] = [],
): string {
  const link = meta.documentUrl || meta.sourceUrl;
  const extra = extraLines.map((l) => `> ${l}\n`).join('');
  const header =
    `# ${meta.title}\n\n` +
    `> ⚠️ ${provenanceNote}\n` +
    `>\n` +
    `> **Quelle:** ${meta.sourceName} — ${link}\n` +
    `> **Regulierung:** ${meta.regulation} · **Jurisdiktion:** ${meta.jurisdiction}\n` +
    extra +
    `\n---\n\n`;
  return (header + body).slice(0, MAX_MARKDOWN_CHARS);
}

// ───────────────────────── Fetch ─────────────────────────

type FetchImpl = typeof fetch;

type FetchedDoc = { buffer: Buffer; contentType: string | null; finalUrl: string };

async function fetchDocument(url: string, allowRegistrable: string, fetchImpl: FetchImpl): Promise<FetchedDoc> {
  assertFetchableUrl(url, allowRegistrable);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`ingest_http_${res.status}`);
    // Re-check the final URL after redirects (defence against redirect-to-internal).
    assertFetchableUrl(res.url || url, allowRegistrable);
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len && len > MAX_DOCUMENT_BYTES) throw new Error('ingest_too_large');
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_DOCUMENT_BYTES) throw new Error('ingest_too_large');
    return {
      buffer: Buffer.from(ab),
      contentType: res.headers.get('content-type'),
      finalUrl: res.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Convert (network) ─────────────────────────

export type ConvertResult =
  | {
      status: 'INGESTED';
      contentType: DocKind | 'manual-upload';
      documentUrl: string | null;
      rawText: string;
      markdown: string;
      byteSize: number;
      /** A better title discovered during conversion (e.g. HTML <title>), if any. */
      title?: string;
    }
  | { status: 'NEEDS_INPUT' | 'FAILED'; error: string };

const MIN_BODY_CHARS = 200;

/**
 * Fetch + convert the document behind `sourceUrl`. PDF → text directly; HTML →
 * markdown, and if a primary PDF link is found, prefer that PDF. Returns a
 * structured result; never throws for the normal "couldn't get a clean doc"
 * cases — those map to NEEDS_INPUT/FAILED so the row is retryable.
 */
export async function convertFromUrl(
  meta: ProvenanceMeta,
  deps: { fetchImpl?: FetchImpl } = {},
): Promise<ConvertResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let allowRegistrable: string;
  try {
    allowRegistrable = registrableDomain(new URL(meta.sourceUrl).host);
  } catch {
    return { status: 'FAILED', error: 'ingest_invalid_url' };
  }

  try {
    const first = await fetchDocument(meta.sourceUrl, allowRegistrable, fetchImpl);
    const kind = classifyContentType(first.contentType, new Uint8Array(first.buffer));

    if (kind === 'pdf') {
      return finalizePdf(meta, first.buffer, meta.sourceUrl);
    }

    if (kind === 'html') {
      const html = first.buffer.toString('utf8');
      // Prefer a linked PDF when present (cleaner than scraped page text).
      const pdfLink = findPrimaryPdfLink(html, first.finalUrl);
      if (pdfLink) {
        try {
          const pdfDoc = await fetchDocument(pdfLink, allowRegistrable, fetchImpl);
          if (classifyContentType(pdfDoc.contentType, new Uint8Array(pdfDoc.buffer)) === 'pdf') {
            return finalizePdf(meta, pdfDoc.buffer, pdfLink);
          }
        } catch {
          /* fall through to HTML conversion */
        }
      }
      const mdBody = NodeHtmlMarkdown.translate(html).trim();
      const rawText = markdownToPlain(mdBody);
      if (rawText.length < MIN_BODY_CHARS) {
        return { status: 'NEEDS_INPUT', error: 'ingest_no_extractable_text' };
      }
      const htmlTitle = extractHtmlTitle(html);
      return {
        status: 'INGESTED',
        contentType: 'html',
        documentUrl: pdfLink ?? meta.sourceUrl,
        rawText,
        markdown: buildMarkdown(meta, mdBody),
        byteSize: first.buffer.byteLength,
        ...(htmlTitle ? { title: htmlTitle } : {}),
      };
    }

    return { status: 'NEEDS_INPUT', error: 'ingest_unsupported_content_type' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ingest_failed';
    // Allowlist/SSRF and "needs a real document" are admin-actionable → NEEDS_INPUT.
    const needsInput = msg.startsWith('ingest_host') || msg === 'ingest_invalid_url' || msg === 'ingest_scheme_blocked';
    return { status: needsInput ? 'NEEDS_INPUT' : 'FAILED', error: msg };
  }
}

function finalizePdf(meta: ProvenanceMeta, buffer: Buffer, documentUrl: string): Promise<ConvertResult> {
  return parsePDF(buffer).then((text) => {
    const body = text.trim();
    if (body.length < MIN_BODY_CHARS) {
      return { status: 'NEEDS_INPUT', error: 'ingest_pdf_no_text' } as ConvertResult;
    }
    return {
      status: 'INGESTED',
      contentType: 'pdf',
      documentUrl,
      rawText: body,
      markdown: buildMarkdown({ ...meta, documentUrl }, body),
      byteSize: buffer.byteLength,
    } as ConvertResult;
  });
}

/** Convert a manually uploaded file (admin fallback). */
export async function convertFromBuffer(
  meta: ProvenanceMeta,
  buffer: Buffer,
  filename: string,
): Promise<ConvertResult> {
  try {
    const lower = filename.toLowerCase();
    let body: string;
    if (lower.endsWith('.pdf')) body = (await parsePDF(buffer)).trim();
    else if (lower.endsWith('.docx')) body = (await parseDOCX(buffer)).trim();
    else if (lower.endsWith('.txt') || lower.endsWith('.md')) body = buffer.toString('utf8').trim();
    else return { status: 'FAILED', error: 'ingest_unsupported_upload' };

    if (body.length < MIN_BODY_CHARS) return { status: 'NEEDS_INPUT', error: 'ingest_upload_no_text' };
    return {
      status: 'INGESTED',
      contentType: 'manual-upload',
      documentUrl: meta.documentUrl ?? null,
      rawText: lower.endsWith('.md') ? markdownToPlain(body) : body,
      markdown: buildMarkdown(meta, body),
      byteSize: buffer.byteLength,
    };
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : 'ingest_upload_failed' };
  }
}

// ───────────────────────── Store / orchestrate ─────────────────────────

export type IngestionJobInput = {
  suggestionId: string;
  sourceName: string;
  sourceUrl: string;
  regulation: string;
  title: string;
  jurisdiction: Jurisdiction;
};

/**
 * Create the INGESTING row (idempotent by dedupeKey) for an accepted suggestion.
 * Returns the document id, or the existing row's id if already ingested.
 */
export async function createIngestionJob(input: IngestionJobInput): Promise<string> {
  const dedupeKey = normalizeUrl(input.sourceUrl);
  const existing = await db.regulatoryDocument.findUnique({ where: { dedupeKey } });
  if (existing) return existing.id;
  const row = await db.regulatoryDocument.create({
    data: {
      suggestionId: input.suggestionId,
      sourceName: input.sourceName,
      sourceUrl: input.sourceUrl,
      regulation: input.regulation,
      title: input.title,
      jurisdiction: input.jurisdiction,
      status: 'INGESTING',
      dedupeKey,
    },
  });
  return row.id;
}

/**
 * Run (or re-run) ingestion for a stored document row. Loads the row, converts
 * from `documentUrl ?? sourceUrl`, and writes the result back. Never throws —
 * failures are persisted as FAILED/NEEDS_INPUT so the UI can retry.
 */
export async function runIngestion(documentId: string): Promise<void> {
  const doc = await db.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!doc) return;
  await db.regulatoryDocument.update({
    where: { id: documentId },
    data: { status: 'INGESTING', error: null },
  });
  const meta: ProvenanceMeta = {
    title: doc.title,
    sourceName: doc.sourceName,
    sourceUrl: doc.documentUrl ?? doc.sourceUrl,
    documentUrl: doc.documentUrl,
    regulation: doc.regulation,
    jurisdiction: doc.jurisdiction as Jurisdiction,
  };
  const result = await convertFromUrl(meta);
  await persistResult(documentId, result);
  await maybeDetectLanguage(documentId);
}

/** Persist a convert result onto a document row. */
export async function persistResult(documentId: string, result: ConvertResult): Promise<void> {
  if (result.status === 'INGESTED') {
    await db.regulatoryDocument.update({
      where: { id: documentId },
      data: {
        status: 'INGESTED',
        contentType: result.contentType,
        documentUrl: result.documentUrl,
        rawText: result.rawText,
        markdown: result.markdown,
        byteSize: result.byteSize,
        error: null,
        fetchedAt: new Date(),
        ...(result.title ? { title: result.title } : {}),
      },
    });
  } else {
    await db.regulatoryDocument.update({
      where: { id: documentId },
      data: { status: result.status, error: result.error },
    });
  }
}

/**
 * Detect + cache the source language on an INGESTED document (once), so the
 * Bibliothek can offer translation without a per-view DeepL call. No-op when
 * DeepL is not configured or the language is already known.
 */
export async function maybeDetectLanguage(documentId: string): Promise<void> {
  if (!isTranslationConfigured()) return;
  try {
    const doc = await db.regulatoryDocument.findUnique({ where: { id: documentId } });
    if (!doc || doc.status !== 'INGESTED' || doc.originalLanguage) return;
    const text = doc.rawText ?? doc.markdown ?? '';
    if (!text.trim()) return;
    const lang = await detectLanguage(text);
    if (lang) await db.regulatoryDocument.update({ where: { id: documentId }, data: { originalLanguage: lang } });
  } catch {
    /* detection is best-effort — never fail ingestion over it */
  }
}

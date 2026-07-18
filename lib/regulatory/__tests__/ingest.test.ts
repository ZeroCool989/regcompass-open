import { describe, it, expect } from 'vitest';
import {
  registrableDomain,
  assertFetchableUrl,
  inferJurisdiction,
  classifyContentType,
  findPrimaryPdfLink,
  extractHtmlTitle,
  markdownToPlain,
  buildMarkdown,
  convertFromUrl,
  type ProvenanceMeta,
} from '../ingest';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('registrableDomain', () => {
  it('takes the last two labels', () => {
    expect(registrableDomain('www.bafin.de')).toBe('bafin.de');
    expect(registrableDomain('eur-lex.europa.eu')).toBe('europa.eu');
    expect(registrableDomain('www.edoeb.admin.ch')).toBe('admin.ch');
  });
});

describe('assertFetchableUrl (SSRF guard)', () => {
  it('allows official source domains', () => {
    expect(() => assertFetchableUrl('https://eur-lex.europa.eu/x')).not.toThrow();
    expect(() => assertFetchableUrl('https://www.bafin.de/y')).not.toThrow();
    expect(() => assertFetchableUrl('https://www.finma.ch/z')).not.toThrow();
  });
  it('rejects non-allowlisted hosts unless allowRegistrable matches', () => {
    expect(() => assertFetchableUrl('https://evil.example.com/x')).toThrow(/allowlist/);
    expect(() => assertFetchableUrl('https://docs.example.com/x', 'example.com')).not.toThrow();
  });
  it('rejects non-http(s) schemes', () => {
    expect(() => assertFetchableUrl('file:///etc/passwd')).toThrow(/scheme/);
    expect(() => assertFetchableUrl('ftp://eur-lex.europa.eu/x')).toThrow(/scheme/);
  });
  it('rejects IP-literal / localhost / bare hosts (SSRF)', () => {
    expect(() => assertFetchableUrl('http://127.0.0.1/x', '127.0.0.1')).toThrow(/host_blocked/);
    expect(() => assertFetchableUrl('http://localhost/x', 'localhost')).toThrow(/host_blocked/);
    expect(() => assertFetchableUrl('http://intranet/x', 'intranet')).toThrow(/host_blocked/);
    expect(() => assertFetchableUrl('http://169.254.169.254/latest', '169.254.169.254')).toThrow(/host_blocked/);
  });
});

describe('inferJurisdiction', () => {
  it('maps official domains to their jurisdiction', () => {
    expect(inferJurisdiction('https://www.bafin.de/x')).toBe('DE');
    expect(inferJurisdiction('https://www.finma.ch/x')).toBe('CH');
    expect(inferJurisdiction('https://eur-lex.europa.eu/x')).toBe('EU');
  });
  it('falls back to INTL for unknown domains', () => {
    expect(inferJurisdiction('https://example.com/x')).toBe('INTL');
    expect(inferJurisdiction('not a url')).toBe('INTL');
  });
});

describe('classifyContentType', () => {
  it('reads the Content-Type header', () => {
    expect(classifyContentType('application/pdf', bytes(''))).toBe('pdf');
    expect(classifyContentType('text/html; charset=utf-8', bytes(''))).toBe('html');
  });
  it('sniffs magic bytes when the header is unhelpful', () => {
    expect(classifyContentType(null, bytes('%PDF-1.7\n...'))).toBe('pdf');
    expect(classifyContentType('application/octet-stream', bytes('<!DOCTYPE html><html>'))).toBe('html');
    expect(classifyContentType(null, bytes('just text'))).toBe('other');
  });
});

describe('findPrimaryPdfLink', () => {
  it('finds and absolutises the first .pdf anchor', () => {
    const html = '<a href="/docs/guidance.pdf">PDF</a> <a href="x.html">no</a>';
    expect(findPrimaryPdfLink(html, 'https://www.bafin.de/news/')).toBe('https://www.bafin.de/docs/guidance.pdf');
  });
  it('handles a .pdf with a query string', () => {
    const html = '<a href="https://www.finma.ch/a.pdf?v=2">x</a>';
    expect(findPrimaryPdfLink(html, 'https://www.finma.ch/')).toBe('https://www.finma.ch/a.pdf?v=2');
  });
  it('decodes &amp; entities in the href', () => {
    const html = '<a href="https://www.finma.ch/a.pdf?sc_lang=en&amp;hash=ABC">x</a>';
    expect(findPrimaryPdfLink(html, 'https://www.finma.ch/')).toBe('https://www.finma.ch/a.pdf?sc_lang=en&hash=ABC');
  });
  it('returns null when there is no pdf link', () => {
    expect(findPrimaryPdfLink('<a href="/a.html">x</a>', 'https://x.de/')).toBeNull();
  });
});

describe('extractHtmlTitle', () => {
  it('extracts and trims the <title>', () => {
    expect(extractHtmlTitle('<html><head><title>  BaFin – KI  </title></head>')).toBe('BaFin – KI');
  });
  it('returns null when absent', () => {
    expect(extractHtmlTitle('<html><body>x</body></html>')).toBeNull();
  });
});

describe('markdownToPlain', () => {
  it('strips headings, emphasis, blockquotes and link syntax', () => {
    const out = markdownToPlain('# Titel\n\n> Hinweis\n\n**fett** und [Link](https://x.de)');
    expect(out).not.toMatch(/[#*>]/);
    expect(out).toContain('Titel');
    expect(out).toContain('Link');
    expect(out).not.toContain('https://x.de');
  });
});

describe('buildMarkdown', () => {
  const meta: ProvenanceMeta = {
    title: 'BaFin KI-Hinweise',
    sourceName: 'BaFin',
    sourceUrl: 'https://www.bafin.de/ki',
    documentUrl: 'https://www.bafin.de/ki.pdf',
    regulation: 'DORA',
    jurisdiction: 'DE',
  };
  it('prepends a provenance header with the unverified marker', () => {
    const md = buildMarkdown(meta, 'Korpus-Text.');
    expect(md).toContain('# BaFin KI-Hinweise');
    expect(md).toContain('⚠️ Extern eingespeist');
    expect(md).toContain('https://www.bafin.de/ki.pdf'); // prefers documentUrl
    expect(md).toContain('DORA');
    expect(md).toContain('Korpus-Text.');
  });
});

// ── convertFromUrl with a mocked fetch (no network) ──

function mockFetch(map: Record<string, { body: string; contentType: string; url?: string; ok?: boolean }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = map[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: r.ok ?? true,
      url: r.url ?? url,
      headers: new Headers({ 'content-type': r.contentType }),
      arrayBuffer: async () => bytes(r.body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const meta: ProvenanceMeta = {
  title: 'BaFin Meldung',
  sourceName: 'BaFin',
  sourceUrl: 'https://www.bafin.de/news/ki',
  documentUrl: null,
  regulation: 'DORA',
  jurisdiction: 'DE',
};

describe('convertFromUrl', () => {
  it('converts an HTML landing page to markdown (INGESTED)', async () => {
    const longText = 'Die BaFin hat neue Hinweise zur IKT-Sicherheit veröffentlicht. '.repeat(8);
    const html = `<html><head><title>BaFin Hinweise</title></head><body><h1>Hinweise</h1><p>${longText}</p></body></html>`;
    const res = await convertFromUrl(meta, {
      fetchImpl: mockFetch({ 'https://www.bafin.de/news/ki': { body: html, contentType: 'text/html' } }),
    });
    expect(res.status).toBe('INGESTED');
    if (res.status === 'INGESTED') {
      expect(res.contentType).toBe('html');
      expect(res.markdown).toContain('⚠️ Extern eingespeist');
      expect(res.title).toBe('BaFin Hinweise');
      expect(res.rawText.length).toBeGreaterThan(200);
    }
  });

  it('returns NEEDS_INPUT when the page has too little text', async () => {
    const html = '<html><body><p>kurz</p></body></html>';
    const res = await convertFromUrl(meta, {
      fetchImpl: mockFetch({ 'https://www.bafin.de/news/ki': { body: html, contentType: 'text/html' } }),
    });
    expect(res.status).toBe('NEEDS_INPUT');
  });

  it('returns NEEDS_INPUT for an unsupported content type', async () => {
    const res = await convertFromUrl(meta, {
      fetchImpl: mockFetch({ 'https://www.bafin.de/news/ki': { body: 'zipdata', contentType: 'application/zip' } }),
    });
    expect(res.status).toBe('NEEDS_INPUT');
  });

  it('maps an allowlist rejection to NEEDS_INPUT (admin-actionable)', async () => {
    const evilMeta: ProvenanceMeta = { ...meta, sourceUrl: 'https://evil.example.com/x' };
    const res = await convertFromUrl(evilMeta, {
      fetchImpl: mockFetch({ 'https://evil.example.com/x': { body: 'x', contentType: 'text/html' } }),
    });
    expect(res.status).toBe('NEEDS_INPUT');
  });
});

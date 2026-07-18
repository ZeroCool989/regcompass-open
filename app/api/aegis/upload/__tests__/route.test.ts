import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Stub the limiter's RETURN (not its internals) — over-limit vs allowed.
const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check }),
  ipHash: () => 'iphash',
}));

// Auth gate: treat the uploader as a signed-in, approved user.
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1', email: 'u@test', status: 'APPROVED', role: 'USER' }),
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
  isAdminEmail: () => false,
  // Real semantics: approved AND (role ADMIN or allowlisted email).
  requireAdmin: (u: { status?: string; role?: string } | null) =>
    !!u && u.status === 'APPROVED' && u.role === 'ADMIN',
}));

// Owned-session: return a fixed id so the route doesn't mint a cookie.
vi.mock('@/lib/session', () => ({
  SESSION_COOKIE: 'rc_session',
  readSessionId: () => 'sess-1',
  createSession: () => ({ id: 'sess-new', value: 'sess-new.sig' }),
  sessionCookieOptions: () => ({}),
}));

// Persist + parse are covered elsewhere (document-store / parsers.test.ts); here
// we only care about the route's accept/reject contract.
const { storeDocument } = vi.hoisted(() => ({ storeDocument: vi.fn() }));
vi.mock('@/lib/aegis/document-store', () => ({ storeDocument }));

const { parseExcelToSheets, parsePDF, parseDOCX } = vi.hoisted(() => ({
  parseExcelToSheets: vi.fn(),
  parsePDF: vi.fn(),
  parseDOCX: vi.fn(),
}));
vi.mock('@/lib/aegis/parsers', () => ({
  parseExcelToSheets,
  parsePDF,
  parseDOCX,
  // Real implementation: the route now reports full-text size honestly (DOC-2).
  capText: (text: string) => ({ text, totalChars: text.length, truncated: false }),
}));

import { POST } from '../route';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n', 'latin1');

function uploadReq(file: File, type = 'policy'): NextRequest {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('type', type);
  return new NextRequest('http://localhost/api/aegis/upload', { method: 'POST', body: fd });
}

beforeEach(() => {
  check.mockResolvedValue({ ok: true, remaining: 19, resetAt: Date.now() + 1000 });
  storeDocument.mockResolvedValue('file-123');
});
afterEach(() => {
  check.mockReset();
  storeDocument.mockReset();
  parseExcelToSheets.mockReset();
  parsePDF.mockReset();
  parseDOCX.mockReset();
});

describe('POST /api/aegis/upload', () => {
  it('429 when the limiter returns ok:false (+ Retry-After)', async () => {
    check.mockResolvedValue({ ok: false, remaining: 0, resetAt: Date.now() + 1000 });
    const file = new File([ZIP], 'doc.pdf', { type: 'application/pdf' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('400 when magic bytes do not match the declared type', async () => {
    // Declares PDF, but the bytes are a ZIP header → mismatch.
    const file = new File([ZIP], 'masquerade.pdf', { type: 'application/pdf' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_input');
    expect(body.message).toMatch(/entspricht nicht dem angegebenen Dateityp/);
    expect(storeDocument).not.toHaveBeenCalled();
  });

  it('400 for an unsupported file type', async () => {
    const file = new File([Buffer.from('x')], 'archive.bin', { type: 'application/zip' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/Nicht unterstütztes Dateiformat/);
  });

  it('accepts a valid xlsx template (exceljs path) and stores it', async () => {
    parseExcelToSheets.mockResolvedValue({
      sheets: [{ name: 'Sheet1', headers: ['Control', 'Status'], rows: [{ Control: 'A', Status: 'ok' }] }],
    });
    const file = new File([ZIP], 'template.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const res = await POST(uploadReq(file, 'template'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ fileId: 'file-123', type: 'template' });
    expect(body.sheets[0]).toMatchObject({ name: 'Sheet1', rowCount: 1 });
    expect(parseExcelToSheets).toHaveBeenCalledOnce();
    expect(storeDocument).toHaveBeenCalledOnce();
  });

  it('accepts a .md upload and routes it through the text path (no binary parser)', async () => {
    const file = new File([Buffer.from('# Title\n\nDORA Art. 8 asset inventory.', 'utf8')], 'notes.md', {
      type: 'text/markdown',
    });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ fileId: 'file-123', type: 'policy' });
    expect(body.textContent).toContain('DORA Art. 8');
    // Text path uses TextDecoder inline — none of the binary parsers run.
    expect(parsePDF).not.toHaveBeenCalled();
    expect(parseDOCX).not.toHaveBeenCalled();
    expect(parseExcelToSheets).not.toHaveBeenCalled();
    expect(storeDocument).toHaveBeenCalledOnce();
  });

  it('422 no_extractable_text for a scanned PDF (parses fine, zero text) — nothing stored (DOC-1)', async () => {
    parsePDF.mockResolvedValue('   \n\t  ');
    const file = new File([PDF], 'scan.pdf', { type: 'application/pdf' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('no_extractable_text');
    expect(body.message).toMatch(/gescanntes/);
    expect(storeDocument).not.toHaveBeenCalled();
  });

  it('422 when a parser throws on a malformed document (production: no detail leaked)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    parsePDF.mockRejectedValue(
      Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' }),
    );
    const file = new File([PDF], 'broken.pdf', { type: 'application/pdf' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('parse_error');
    expect(body.message).toMatch(/konnte nicht gelesen werden/);
    expect(body.detail).toBeUndefined();
    expect(storeDocument).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('422 in development includes a safe detail (error name + first message line only)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    parsePDF.mockRejectedValue(
      Object.assign(new Error('Invalid PDF structure\nat parser (pdf.js:1234)\nmore stack'), {
        name: 'InvalidPDFException',
      }),
    );
    const file = new File([PDF], 'broken.pdf', { type: 'application/pdf' });
    const res = await POST(uploadReq(file));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('parse_error');
    // First line only — stack lines are dropped.
    expect(body.detail).toBe('InvalidPDFException: Invalid PDF structure');
    expect(body.detail).not.toContain('pdf.js');
    expect(body.detail).not.toContain('\n');
    vi.unstubAllEnvs();
  });
});

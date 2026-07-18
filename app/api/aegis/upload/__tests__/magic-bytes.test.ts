import { describe, expect, it, vi } from 'vitest';

// The pure validators don't touch the DB, but importing the route module pulls
// in @/lib/db transitively (via rate-limit / document-store). Stub it so the
// unit test never instantiates Prisma.
vi.mock('@/lib/db', () => ({ db: {} }));

import { detectFormat, magicBytesOk } from '../route';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]); // PK\x03\x04
const TEXT = Buffer.from('Hello, compliance world.', 'utf8');

describe('magicBytesOk', () => {
  it('pdf: accepts a real %PDF- header, rejects wrong/short', () => {
    expect(magicBytesOk('pdf', PDF)).toBe(true);
    expect(magicBytesOk('pdf', Buffer.from('%PDF-', 'latin1'))).toBe(true); // exactly 5
    expect(magicBytesOk('pdf', Buffer.from('NOTPDF', 'latin1'))).toBe(false);
    expect(magicBytesOk('pdf', Buffer.from('%PD', 'latin1'))).toBe(false); // < 5
  });

  it('docx: accepts the ZIP local-file header, rejects wrong/short', () => {
    expect(magicBytesOk('docx', ZIP)).toBe(true);
    expect(magicBytesOk('docx', Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false); // empty-archive sig
    expect(magicBytesOk('docx', Buffer.from([0x50, 0x4b, 0x03]))).toBe(false); // < 4
    expect(magicBytesOk('docx', PDF)).toBe(false);
  });

  it('excel: accepts the ZIP header (OOXML), rejects a CFB/legacy .xls header', () => {
    expect(magicBytesOk('excel', ZIP)).toBe(true);
    // Legacy .xls (CFB) starts with D0 CF 11 E0 — intentionally unsupported.
    expect(magicBytesOk('excel', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe(false);
  });

  it('pptx: accepts the ZIP header (OOXML), rejects a non-zip header', () => {
    expect(magicBytesOk('pptx', ZIP)).toBe(true);
    expect(magicBytesOk('pptx', PDF)).toBe(false);
    expect(magicBytesOk('pptx', Buffer.from([0x50, 0x4b, 0x03]))).toBe(false); // < 4
  });

  it('text: accepts NUL-free content, rejects a NUL byte in the first KiB', () => {
    expect(magicBytesOk('text', TEXT)).toBe(true);
    expect(magicBytesOk('text', Buffer.from('hello\0world', 'utf8'))).toBe(false);
    // NUL only AFTER the first 1 KiB → still accepted (only the first 1024 are scanned).
    const lateNul = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.from([0x00])]);
    expect(magicBytesOk('text', lateNul)).toBe(true);
  });
});

describe('detectFormat', () => {
  it('maps known MIME types', () => {
    expect(detectFormat('application/pdf', 'x')).toBe('pdf');
    expect(
      detectFormat(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x',
      ),
    ).toBe('docx');
    expect(
      detectFormat(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x',
      ),
    ).toBe('excel');
    expect(
      detectFormat(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'x',
      ),
    ).toBe('pptx');
    expect(detectFormat('text/plain', 'x')).toBe('text');
  });

  it('falls back to the file extension (case-insensitive) when MIME is unknown', () => {
    expect(detectFormat('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(detectFormat('', 'memo.DOCX')).toBe('docx');
    expect(detectFormat('', 'sheet.xlsx')).toBe('excel');
    expect(detectFormat('', 'deck.PPTX')).toBe('pptx');
    expect(detectFormat('', 'notes.txt')).toBe('text');
  });

  it('maps Markdown MIME types and the .md/.markdown extension to text', () => {
    expect(detectFormat('text/markdown', 'x')).toBe('text');
    expect(detectFormat('text/x-markdown', 'x')).toBe('text');
    // Browsers often report no MIME for .md → extension fallback (case-insensitive).
    expect(detectFormat('', 'README.md')).toBe('text');
    expect(detectFormat('', 'notes.MD')).toBe('text');
    expect(detectFormat('', 'answer-key.markdown')).toBe('text');
  });

  it('MIME takes precedence over a conflicting extension', () => {
    expect(detectFormat('application/pdf', 'masquerade.docx')).toBe('pdf');
  });

  it('returns null for unsupported type and extension', () => {
    expect(detectFormat('application/zip', 'archive.bin')).toBeNull();
    expect(detectFormat('', 'noext')).toBeNull();
  });
});

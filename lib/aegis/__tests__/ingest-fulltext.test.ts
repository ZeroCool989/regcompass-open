import { describe, expect, it, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { capText, parsePPTX, parseDOCX } from '../parsers';

/**
 * Review 2026-07 DOC-2: parsers silently sliced every document to 100k chars —
 * findings about the dropped tail were simply wrong. Extraction now returns
 * full text; only the explicit, reported safety ceiling can cut it.
 */
describe('full-text extraction (DOC-2)', () => {
  afterEach(() => {
    delete process.env.AEGIS_MAX_DOC_CHARS;
  });

  it('capText passes normal documents through untouched', () => {
    const text = 'a'.repeat(150_000); // would have been cut at 100k before
    const parsed = capText(text);
    expect(parsed.text.length).toBe(150_000);
    expect(parsed.totalChars).toBe(150_000);
    expect(parsed.truncated).toBe(false);
  });

  it('capText reports the ceiling instead of cutting silently', () => {
    process.env.AEGIS_MAX_DOC_CHARS = '1000';
    const parsed = capText('b'.repeat(2_500));
    expect(parsed.text.length).toBe(1000);
    expect(parsed.totalChars).toBe(2_500);
    expect(parsed.truncated).toBe(true);
  });

  it('parseDOCX no longer truncates at 100k chars', async () => {
    // mammoth reads OPC; build a minimal docx with >100k chars of text.
    const body = `<w:p><w:r><w:t>${'x'.repeat(120_000)}</w:t></w:r></w:p>`;
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`;
    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>';
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
    const buf = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8(contentTypes),
        '_rels/.rels': strToU8(rels),
        'word/document.xml': strToU8(documentXml),
      }),
    );
    const text = await parseDOCX(buf);
    expect(text.length).toBeGreaterThan(100_000);
  });
});

describe('OOXML zip-bomb guard (DOC-7)', () => {
  it('rejects archives inflating past the ceiling', async () => {
    // Highly compressible parts: small zip, huge decompressed size.
    const huge = strToU8('A'.repeat(30 * 1024 * 1024)); // 30MB × 4 parts > 100MB
    const parts: Record<string, Uint8Array> = {
      'ppt/slides/slide1.xml': strToU8('<a:p><a:r><a:t>ok</a:t></a:r></a:p>'),
    };
    for (let i = 0; i < 4; i++) parts[`ppt/media/junk${i}.bin`] = huge;
    const buf = Buffer.from(zipSync(parts));
    await expect(parsePPTX(buf)).rejects.toThrow(/unplausibel/);
  });
});

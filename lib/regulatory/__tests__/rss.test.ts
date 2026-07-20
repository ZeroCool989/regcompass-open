import { describe, expect, it } from 'vitest';
import { feedDateToIso, parseFeed, stripHtml } from '../rss';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>BaFin</title>
  <item>
    <title>Neue Allgemeinverfügung zu DORA</title>
    <link>https://www.bafin.de/dora-123</link>
    <description><![CDATA[<p>Die BaFin veröffentlicht Hinweise zur <b>DORA</b>-Umsetzung.</p>]]></description>
    <pubDate>Tue, 15 Jul 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Kein Link hier</title>
    <description>wird verworfen</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ENISA</title>
  <entry>
    <title>NIS2 guidance published</title>
    <link href="https://www.enisa.europa.eu/nis2-guide" rel="alternate"/>
    <summary>ENISA released NIS2 implementation guidance.</summary>
    <published>2026-07-16T12:00:00Z</published>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 items, decodes CDATA/HTML, drops linkless items', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Neue Allgemeinverfügung zu DORA');
    expect(items[0].link).toBe('https://www.bafin.de/dora-123');
    expect(items[0].summary).toBe('Die BaFin veröffentlicht Hinweise zur DORA-Umsetzung.');
    expect(items[0].date).toBe('Tue, 15 Jul 2026 09:00:00 GMT');
  });

  it('parses Atom entries and reads the alternate link href', () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('NIS2 guidance published');
    expect(items[0].link).toBe('https://www.enisa.europa.eu/nis2-guide');
    expect(items[0].date).toBe('2026-07-16T12:00:00Z');
  });

  it('returns [] for junk instead of throwing', () => {
    expect(parseFeed('not xml at all')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes entities, collapses whitespace', () => {
    expect(stripHtml('<p>a &amp; b\n   c</p>')).toBe('a & b c');
  });
});

describe('feedDateToIso', () => {
  it('normalises RFC-822 and ISO dates to YYYY-MM-DD', () => {
    expect(feedDateToIso('Tue, 15 Jul 2026 09:00:00 GMT')).toBe('2026-07-15');
    expect(feedDateToIso('2026-07-16T12:00:00Z')).toBe('2026-07-16');
  });

  it('returns null for missing or unparseable dates', () => {
    expect(feedDateToIso(null)).toBeNull();
    expect(feedDateToIso('irgendwann')).toBeNull();
  });
});

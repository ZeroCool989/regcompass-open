import { describe, expect, it, vi } from 'vitest';
import { fetchRssNews } from '../research';
import type { RegulatoryFeed } from '../feeds';

const NOW = Date.parse('2026-07-20T00:00:00Z');

const FEEDS: RegulatoryFeed[] = [
  { name: 'BaFin', jurisdiction: 'DE', feedUrl: 'https://www.bafin.de/feed.xml' },
  { name: 'ENISA', jurisdiction: 'EU', feedUrl: 'https://www.enisa.europa.eu/feed.xml' },
];

const BAFIN_XML = `<rss version="2.0"><channel>
  <item>
    <title>DORA-Umsetzungshinweise veröffentlicht</title>
    <link>https://www.bafin.de/dora-1</link>
    <description>Hinweise zur DORA-Umsetzung im Finanzsektor.</description>
    <pubDate>Wed, 16 Jul 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Alte Meldung ausserhalb des Fensters</title>
    <link>https://www.bafin.de/old-1</link>
    <description>Sollte herausgefiltert werden.</description>
    <pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ENISA_XML = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>NIS2 and Cybersecurity guidance</title>
    <link href="https://www.enisa.europa.eu/nis2" rel="alternate"/>
    <summary>New NIS2 cybersecurity guidance.</summary>
    <published>2026-07-18T10:00:00Z</published>
  </entry>
</feed>`;

function fetchStub(map: Record<string, { status?: number; body?: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    const entry = map[key];
    if (!entry) return { ok: false, status: 404, text: async () => '' } as Response;
    if (entry.status && entry.status >= 400) {
      return { ok: false, status: entry.status, text: async () => '' } as Response;
    }
    return { ok: true, status: 200, text: async () => entry.body ?? '' } as Response;
  }) as unknown as typeof fetch;
}

describe('fetchRssNews', () => {
  it('maps feed items to news, filters by window, derives tags/jurisdiction', async () => {
    const fetchImpl = fetchStub({
      'https://www.bafin.de/feed.xml': { body: BAFIN_XML },
      'https://www.enisa.europa.eu/feed.xml': { body: ENISA_XML },
    });
    const { news, status } = await fetchRssNews({ feeds: FEEDS, windowDays: 7, now: NOW, fetchImpl });

    // The June item is outside the 7-day window → dropped.
    expect(news.map((n) => n.sourceUrl).sort()).toEqual([
      'https://www.bafin.de/dora-1',
      'https://www.enisa.europa.eu/nis2',
    ]);
    const bafin = news.find((n) => n.sourceUrl.includes('dora-1'))!;
    expect(bafin.jurisdiction).toBe('DE');
    expect(bafin.sourceName).toBe('BaFin');
    expect(bafin.tags).toContain('DORA');
    expect(bafin.publishedAt).toBe('2026-07-16');
    const enisa = news.find((n) => n.sourceUrl.includes('nis2'))!;
    expect(enisa.tags).toEqual(expect.arrayContaining(['NIS2', 'Cybersecurity']));
    expect(status.every((s) => s.ok)).toBe(true);
  });

  it('records a failed feed without failing the run', async () => {
    const fetchImpl = fetchStub({
      'https://www.bafin.de/feed.xml': { body: BAFIN_XML },
      'https://www.enisa.europa.eu/feed.xml': { status: 500 },
    });
    const { news, status } = await fetchRssNews({ feeds: FEEDS, windowDays: 7, now: NOW, fetchImpl });
    expect(news).toHaveLength(1); // only BaFin's in-window item
    const enisa = status.find((s) => s.name === 'ENISA')!;
    expect(enisa.ok).toBe(false);
    expect(enisa.error).toBe('http_500');
  });

  it('skips unsafe feed URLs (SSRF guard)', async () => {
    const spy = vi.fn();
    const bad: RegulatoryFeed[] = [{ name: 'Internal', jurisdiction: 'EU', feedUrl: 'http://localhost/feed' }];
    const { news, status } = await fetchRssNews({
      feeds: bad,
      now: NOW,
      fetchImpl: (async () => { spy(); return { ok: true, status: 200, text: async () => '' } as Response; }) as unknown as typeof fetch,
    });
    expect(news).toEqual([]);
    expect(status[0]).toMatchObject({ ok: false, error: 'unsafe_url' });
    expect(spy).not.toHaveBeenCalled();
  });
});

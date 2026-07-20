/**
 * Minimal, dependency-free RSS 2.0 / Atom parser — just enough for the curated
 * regulator feeds the radar polls. Regulator feeds are well-formed; this trades
 * a full XML dependency for a small, defensive extractor. Anything it cannot
 * make sense of yields no item rather than throwing, so one odd entry never
 * fails a feed.
 */

export type RawFeedItem = {
  title: string;
  link: string;
  summary: string;
  /** Raw date string from the feed (pubDate / published / updated), if any. */
  date: string | null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

/** Strip tags and collapse whitespace — feed summaries often carry HTML. */
export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    // A tag between a word and a hyphenated suffix (…zur <b>DORA</b>-Umsetzung)
    // leaves a stray space before the joining hyphen — close the compound back up.
    .replace(/\s+-(?=[\p{L}\p{N}])/gu, '-')
    .trim();
}

function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

/** Atom links are attributes: <link href="…" rel="alternate"/>. */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  if (links.length === 0) return null;
  const alt = links.find((l) => /rel=["']?alternate["']?/i.test(l[1])) ?? links[0];
  const href = alt[1].match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]).trim() : null;
}

function extractBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map(
    (m) => m[1],
  );
}

/**
 * Parse an RSS or Atom document into raw items. Returns [] for anything
 * unrecognisable — the caller decides how to handle an empty feed.
 */
export function parseFeed(xml: string): RawFeedItem[] {
  const items = extractBlocks(xml, 'item'); // RSS 2.0
  const entries = items.length > 0 ? items : extractBlocks(xml, 'entry'); // Atom
  const isAtom = items.length === 0 && entries.length > 0;

  return entries.flatMap((block) => {
    const title = firstTag(block, 'title');
    if (!title) return [];
    const link = isAtom ? atomLink(block) : firstTag(block, 'link');
    if (!link) return [];
    const rawSummary =
      firstTag(block, 'description') ??
      firstTag(block, 'summary') ??
      firstTag(block, 'content') ??
      '';
    const date =
      firstTag(block, 'pubDate') ??
      firstTag(block, 'published') ??
      firstTag(block, 'updated') ??
      firstTag(block, 'dc:date') ??
      null;
    return [{ title: stripHtml(title), link: link.trim(), summary: stripHtml(rawSummary), date }];
  });
}

/** Parse a feed date into ISO YYYY-MM-DD, or null when unparseable. */
export function feedDateToIso(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

import type { KbSuggestion, NewsItem } from './types';

/** Normalize a URL for dedup: lowercase host, drop hash/trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Stable slug for titles/regulations used in dedupe keys. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Dedup key for a news item: normalized URL + title slug + published date. */
export function newsDedupeKey(
  item: Pick<NewsItem, 'sourceUrl' | 'title' | 'publishedAt'>,
): string {
  const date = (item.publishedAt ?? '').slice(0, 10);
  return `${normalizeUrl(item.sourceUrl)}|${slug(item.title)}|${date}`;
}

/** Dedup key for a KB suggestion: URL + regulation + (proposed id or text slug). */
export function suggestionDedupeKey(
  item: Pick<KbSuggestion, 'sourceUrl' | 'regulation' | 'proposedRequirementId' | 'proposedRequirementText'>,
): string {
  const ref = item.proposedRequirementId?.trim() || slug(item.proposedRequirementText).slice(0, 40);
  return `${normalizeUrl(item.sourceUrl)}|${slug(item.regulation)}|${ref}`;
}

/** Drop within-batch duplicates by key (keep first occurrence). */
export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = newsDedupeKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function dedupeSuggestions(items: KbSuggestion[]): KbSuggestion[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = suggestionDedupeKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

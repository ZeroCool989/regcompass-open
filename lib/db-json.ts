// SQLite has no scalar-list columns, so string[] fields (AegisMessage.citedIds,
// AegisUsageLog.guardrailsTriggered, RegulatoryNewsItem.tags) are stored as a
// JSON-encoded string. These helpers translate at the DB boundary.

/** Encode a string[] for storage. */
export function encodeStrList(list: readonly string[] | null | undefined): string {
  return JSON.stringify(list ?? []);
}

/**
 * Decode a stored value into string[]. Tolerant: accepts a JSON string, an
 * already-parsed array (in-memory test doubles), or null → [].
 */
export function decodeStrList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

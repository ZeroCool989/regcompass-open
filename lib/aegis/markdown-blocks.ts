/**
 * Pure block-level parser for AEGIS chat markdown. Kept JSX-free and separate
 * from the renderer (components/AegisChatPanel.tsx) so the block segmentation
 * and the criticality-badge detection can be unit-tested without mounting React.
 */

export type Block =
  | { type: 'heading'; level: number; text: string }
  /** Legacy law-source callout ("⚠️ Quelle: …"). */
  | { type: 'warning'; text: string }
  /** Markdown blockquote (`> …`). `warn` styles ⚠️ notes amber. */
  | { type: 'quote'; text: string; warn: boolean }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }
  | { type: 'hr' };

// ⚠ is U+26A0 followed by an OPTIONAL variation selector U+FE0F — match both
// forms explicitly (a naive `[⚠️]` class matches only one of the two code points).
const WARNING_PREFIX_RE = /^\s*⚠️?\s*(quelle:|source:)/i;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_UL_RE = /^[-*+]\s+(.*)$/;
const LIST_OL_RE = /^\d+\.\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*[-:]+(\s*\|\s*[-:]+)+\s*\|?\s*$/;
const HR_RE = /^([-*_])\1{2,}$/;
const QUOTE_LINE_RE = /^\s*>\s?/;
const WARN_EMOJI_RE = /⚠️|⚠/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const blockTexts = text.split(/\r?\n\s*\r?\n+/).filter((b) => b.trim().length > 0);
  for (const raw of blockTexts) {
    const lines = raw.split(/\r?\n/);
    const first = lines[0]?.trim() ?? '';

    // Blockquote (`> …`): every line is a quote line. Rendered as a callout —
    // amber when it carries a ⚠️ note, brand-accent otherwise. Checked BEFORE the
    // legacy warning branch so `> ⚠️ Hinweis` blocks (and the degradation /
    // continuation banners) render as proper callouts, not the law-source box.
    if (lines.every((l) => QUOTE_LINE_RE.test(l))) {
      const inner = lines.map((l) => l.replace(QUOTE_LINE_RE, '')).join('\n').trim();
      blocks.push({ type: 'quote', text: inner, warn: WARN_EMOJI_RE.test(inner) });
      continue;
    }

    // Legacy law-source callout — only the explicit "⚠️ Quelle:/Source:" form.
    if (WARNING_PREFIX_RE.test(first)) {
      blocks.push({ type: 'warning', text: raw });
      continue;
    }

    // Horizontal rule: `---`, `***`, `___` on its own line
    if (lines.length === 1 && HR_RE.test(first)) {
      blocks.push({ type: 'hr' });
      continue;
    }

    // Heading
    const headingMatch = first.match(HEADING_RE);
    if (headingMatch && lines.length === 1) {
      blocks.push({
        type: 'heading',
        level: Math.min(headingMatch[1].length, 4),
        text: headingMatch[2],
      });
      continue;
    }

    // Table (line[1] is the separator)
    if (lines.length >= 2 && lines[0].includes('|') && TABLE_SEP_RE.test(lines[1])) {
      const headers = lines[0]
        .split('|')
        .map((c) => c.trim())
        .filter((c, idx, arr) => !(idx === 0 || idx === arr.length - 1) || c.length > 0);
      const rows = lines.slice(2).map((r) =>
        r
          .split('|')
          .map((c) => c.trim())
          .filter((c, idx, arr) => !(idx === 0 || idx === arr.length - 1) || c.length > 0),
      );
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Lists
    if (lines.every((l) => LIST_UL_RE.test(l.trim()))) {
      blocks.push({ type: 'ul', items: lines.map((l) => l.trim().match(LIST_UL_RE)![1]) });
      continue;
    }
    if (lines.every((l) => LIST_OL_RE.test(l.trim()))) {
      blocks.push({ type: 'ol', items: lines.map((l) => l.trim().match(LIST_OL_RE)![1]) });
      continue;
    }

    // Default: paragraph (preserve internal line breaks as soft breaks)
    blocks.push({ type: 'paragraph', text: raw });
  }
  return blocks;
}

export type Criticality = {
  /** Severity bucket, derived from the leading traffic-light emoji. */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** The text after the emoji (e.g. "Kritisch (CH)"); falls back to the emoji. */
  label: string;
};

const CRITICALITY_RE = /^\s*(🔴|🟠|🟡|🟢)\s*(.*)$/u;
const SEVERITY_BY_DOT: Record<string, Criticality['severity']> = {
  '🔴': 'critical',
  '🟠': 'high',
  '🟡': 'medium',
  '🟢': 'low',
};

/**
 * Detect a table cell that leads with a traffic-light emoji (🔴/🟠/🟡/🟢) so the
 * renderer can show it as a coloured criticality badge instead of a bare emoji.
 * Returns null for ordinary cells. Regulation-agnostic.
 */
export function parseCriticality(cell: string): Criticality | null {
  const m = cell.match(CRITICALITY_RE);
  if (!m) return null;
  return { severity: SEVERITY_BY_DOT[m[1]], label: m[2].trim() || m[1] };
}

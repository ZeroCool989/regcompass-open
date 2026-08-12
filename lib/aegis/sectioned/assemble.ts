import { appendMessage } from '../memory';
import { callHaiku } from '../client';
import { MODEL_IDS } from '../types';
import { ADVISORY_SECTION_NOTE_DE, DEGRADED_SECTION_NOTE_DE } from '../statusLabels';
import type { ClaudeUsage } from '../context/cost';
import type { JobDb, SectionRow } from './job-store';
import { db } from '@/lib/db';

/**
 * Deterministic assembler (epic PR 2, replaces the Station-2 `naiveAssemble`).
 * Pure TS — ordering, heading normalisation, verbatim-block dedupe, honest
 * labelling. No model rewrites section content, ever; the optional glue pass
 * (`AEGIS_GLUE_PASS_ENABLED`) is purely ADDITIVE (a short intro before the
 * first section) and off by default.
 *
 * Honesty labels (docs/CLAUDE.md, decision D9):
 *   - grounded=false sections carry the advisory note (plan contract).
 *   - degraded sections carry the not-fully-verified note — verify RAN and
 *     failed; the label never appears for time pressure alone.
 */

export function gluePassEnabled(): boolean {
  return process.env.AEGIS_GLUE_PASS_ENABLED === '1' || process.env.AEGIS_GLUE_PASS_ENABLED === 'true';
}

/** Minimum size for a paragraph to participate in verbatim dedupe. */
const DEDUPE_MIN_CHARS = 240;

/**
 * Section content arrives as markdown that may carry its own `##` headings —
 * demote everything below the assembler's section level so the report outline
 * stays exactly the plan outline.
 */
function demoteHeadings(md: string): string {
  return md.replace(/^(#{2,5})(\s)/gm, (_, hashes: string, sp: string) => `#${hashes}${sp}`);
}

function normalizeParagraph(p: string): string {
  return p.replace(/\s+/g, ' ').trim().toLowerCase();
}

export type AssembledReport = {
  text: string;
  citations: string[];
  /** Verbatim paragraphs dropped because an earlier section already shipped them. */
  dedupedBlocks: number;
  degradedSections: number;
};

type SectionMeta = { grounded: boolean } | null;

function sectionPlanMeta(s: SectionRow): SectionMeta {
  const scope = s.scopeJson as { grounded?: unknown } | null;
  if (scope && typeof scope.grounded === 'boolean') return { grounded: scope.grounded };
  return null;
}

export function assembleReport(sections: SectionRow[]): AssembledReport {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const parts: string[] = [];
  const citations = new Set<string>();
  const seenParagraphs = new Set<string>();
  let dedupedBlocks = 0;
  let degradedSections = 0;

  for (const s of ordered) {
    if (!s.contentMd) continue;

    // Verbatim-block dedupe across sections: a paragraph an earlier section
    // already shipped (>= DEDUPE_MIN_CHARS) is dropped deterministically —
    // the repair pass usually fixes duplication; this is the safety net.
    const paragraphs = demoteHeadings(s.contentMd.trim()).split(/\n{2,}/);
    const kept: string[] = [];
    for (const p of paragraphs) {
      const norm = normalizeParagraph(p);
      if (norm.length >= DEDUPE_MIN_CHARS) {
        if (seenParagraphs.has(norm)) {
          dedupedBlocks++;
          continue;
        }
        seenParagraphs.add(norm);
      }
      kept.push(p);
    }

    const meta = sectionPlanMeta(s);
    const notes: string[] = [];
    if (meta && !meta.grounded) notes.push(ADVISORY_SECTION_NOTE_DE);
    if (s.status === 'degraded') {
      degradedSections++;
      notes.push(DEGRADED_SECTION_NOTE_DE);
    }

    parts.push(
      [`## ${s.title}`, ...(notes.length ? [notes.join('\n\n')] : []), kept.join('\n\n')].join('\n\n'),
    );
    for (const c of (s.citationsJson as string[] | null) ?? []) citations.add(c);
  }

  return {
    text: parts.join('\n\n'),
    citations: [...citations],
    dedupedBlocks,
    degradedSections,
  };
}

/**
 * Optional glue pass: ONE short Haiku call that writes a 2–3 sentence German
 * intro paragraph placed BEFORE the first section. Additive only — failure or
 * flag-off simply yields the report without an intro. Section text is never
 * touched.
 */
export async function maybeGlueIntro(
  report: AssembledReport,
  titles: string[],
  // The request's frozen provider selection — the optional glue call dispatches
  // on the same brain as the run, never a dev AEGIS_BRAIN override.
  provider: 'anthropic' | 'gemini' | undefined,
  onUsage?: (model: string, usage: ClaudeUsage) => void,
  call: typeof callHaiku = callHaiku,
): Promise<string> {
  if (!gluePassEnabled() || report.text.length === 0) return report.text;
  try {
    const { text: intro, usage } = await call({
      model: MODEL_IDS.haiku,
      prompt:
        'Schreibe eine Einleitung (2–3 Sätze, DEUTSCH) für einen Regulatorik-Report. ' +
        'NUR die Einleitung ausgeben — keine Überschrift, keine Aufzählung, keine Zitate, ' +
        'keine neuen Fakten oder Regulierungsangaben.\n\n' +
        `Der Report hat folgende Abschnitte: ${titles.join('; ')}`,
      maxTokens: 300,
      provider,
    });
    onUsage?.(MODEL_IDS.haiku, usage);
    const trimmed = intro.trim();
    return trimmed ? `${trimmed}\n\n${report.text}` : report.text;
  } catch {
    return report.text; // additive-only: glue failure never degrades the report
  }
}

/** Persist the assembled report as the turn's assistant message (fail-open). */
export async function persistAssembledReport(args: {
  jobId: string;
  conversationId: string;
  mode: string;
  /** The request's frozen provider selection — pins the optional glue call. */
  provider?: 'anthropic' | 'gemini';
  client?: JobDb;
  onUsage?: (model: string, usage: ClaudeUsage) => void;
}): Promise<boolean> {
  try {
    const client = args.client ?? (db as unknown as JobDb);
    const sections = await client.aegisJobSection.findMany({
      where: { jobId: args.jobId },
      orderBy: { index: 'asc' },
    });
    const report = assembleReport(sections);
    if (!report.text) return false;
    const text = await maybeGlueIntro(
      report,
      sections.map((s) => s.title),
      args.provider,
      args.onUsage,
    );
    const seq = await appendMessage(args.conversationId, {
      role: 'assistant',
      content: text,
      citedIds: report.citations,
      status: 'complete',
      exitReason: 'sectioned_done',
      model: MODEL_IDS.sonnet,
      mode: args.mode,
      toolCalls: [],
    });
    if (report.dedupedBlocks > 0) {
      console.warn(
        JSON.stringify({
          event: 'aegis_assemble_dedupe',
          level: 'warn',
          jobId: args.jobId,
          dedupedBlocks: report.dedupedBlocks,
        }),
      );
    }
    return seq !== null;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'aegis_sectioned_persist_failed',
        level: 'error',
        jobId: args.jobId,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

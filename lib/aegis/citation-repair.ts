import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import { regulationShortName } from './gap-finding';
import type { VerifyCheck } from './types';

/**
 * Citation-repair: a cheap, tool-free recovery for verify failures in the
 * "citation family" (an answer that names articles/obligations but is missing
 * or has wrong [R-...] IDs). Instead of re-running the full inner loop (tool
 * discovery + full regeneration → the timeout driver), the agent asks the model
 * to ONLY fix citations in the existing draft, using the IDs it already
 * retrieved this turn. Regulation-agnostic; no rule is weakened — the repaired
 * text must still pass the unchanged verifier.
 *
 * This module is pure (message/evidence building); the actual model call lives
 * in loop.ts so it can account cost and reuse the cached tool prefix.
 */

/** Verify checks that a citation-only repair can plausibly fix. */
export const CITATION_FAMILY: ReadonlySet<VerifyCheck> = new Set<VerifyCheck>([
  'citation_coverage',
  'unsupported_regulatory_claim',
]);

export function isCitationFamily(check: VerifyCheck): boolean {
  return CITATION_FAMILY.has(check);
}

/**
 * Render the already-retrieved IDs as "[R-...] — <Reg> <Article> — <Title>" so
 * the repair call can attach the correct citation per paragraph. Unknown IDs
 * (never in the KB) are skipped — only real, retrieved entries are offered.
 */
export function renderAllowedEvidence(allowedIds: Set<string>): string {
  const lines: string[] = [];
  for (const id of allowedIds) {
    const req = KB.byId(id);
    if (!req) continue;
    const title = (req.titleDe?.trim() || req.title || '').trim();
    lines.push(`[${id}] — ${regulationShortName(req.regulation)} ${req.article} — ${title}`);
  }
  return lines.join('\n');
}

export const REGULATION_REPAIR_NUDGE =
  'Your previous answer was rejected because it names a regulation, standard or framework that is ' +
  'not part of the knowledge base. Do NOT rewrite, expand or add content. Return the SAME answer, ' +
  'changed ONLY to fix the flagged names:\n' +
  '- Keep every name from the allowed list above unchanged.\n' +
  '- For any other named regulation, standard or framework: remove the name, or reformulate the ' +
  'sentence descriptively without naming it (e.g. "ein etablierter Standard für Informationssicherheit").\n' +
  '- NEVER substitute a flagged name with a DIFFERENT regulation or standard (e.g. ISO 27001 → ' +
  'ISO 42001) — that would be a factual error. Removing the name or reformulating without a name ' +
  'are the ONLY allowed fixes.\n' +
  '- NEVER invent regulation names or [R-...] IDs. Keep all wording, structure, headings, tables, ' +
  'numbering, citations and the language unchanged otherwise.\n' +
  'Return the full corrected answer.';

/**
 * Build the message set for the tool-free regulation-NAME repair call: the
 * canonical seed, the failed draft as the assistant turn to edit, and a user
 * turn with the KB regulation whitelist + the verify feedback + the repair
 * instruction. Mirrors buildCitationRepairMessages; used when verify fails
 * `no_hallucinated_regulations` (e.g. an answer naming ISO 27001), so recovery
 * is one cheap edit instead of a full re-generation.
 */
export function buildRegulationRepairMessages(
  seed: Anthropic.MessageParam[],
  failedText: string,
  feedback: string,
): Anthropic.MessageParam[] {
  const allowed = KB.regulations.map((r) => r.shortName).join(', ');
  return [
    ...seed,
    { role: 'assistant', content: failedText || '(no answer was produced)' },
    {
      role: 'user',
      content: `Allowed regulation short names (keep ONLY these):\n${allowed}\n\n[VERIFY FEEDBACK] ${feedback}\n\n${REGULATION_REPAIR_NUDGE}`,
    },
  ];
}

export const CITATION_REPAIR_NUDGE =
  'Your previous answer was rejected by citation verification. Do NOT rewrite, expand or ' +
  'add content. Return the SAME answer, changed ONLY so that citations are correct:\n' +
  '- Every paragraph that names an article, paragraph (§), Randziffer, chapter, a concrete ' +
  'obligation or a specific requirement MUST carry the matching [R-...] ID, using ONLY the IDs ' +
  'listed above (already retrieved this turn). Insert a missing one, or fix a wrong/citation-less one.\n' +
  '- If no listed ID matches a statement, REMOVE the bare article number or write ' +
  '"nicht durch die Wissensbasis abgedeckt" — NEVER invent or guess an [R-...] ID.\n' +
  '- Keep all wording, structure, headings, tables, numbering and the language unchanged otherwise.\n' +
  'Return the full corrected answer.';

/**
 * Build the message set for the tool-free repair call: the canonical seed, the
 * failed draft as the assistant turn to edit, and a user turn with the available
 * IDs + the verify feedback + the repair instruction.
 */
export function buildCitationRepairMessages(
  seed: Anthropic.MessageParam[],
  failedText: string,
  allowedIds: Set<string>,
  feedback: string,
): Anthropic.MessageParam[] {
  const evidence = renderAllowedEvidence(allowedIds);
  const evidenceBlock = evidence
    ? `Available KB requirement IDs (cite ONLY these):\n${evidence}\n\n`
    : 'No KB requirement IDs are available for this turn — remove bare article numbers or mark statements as "nicht durch die Wissensbasis abgedeckt".\n\n';
  return [
    ...seed,
    { role: 'assistant', content: failedText || '(no answer was produced)' },
    { role: 'user', content: `${evidenceBlock}[VERIFY FEEDBACK] ${feedback}\n\n${CITATION_REPAIR_NUDGE}` },
  ];
}

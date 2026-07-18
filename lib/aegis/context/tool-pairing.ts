import type { ProviderMessageParam } from '../providers/types';

/**
 * Helpers that keep a message array compliant with the canonical tool-pairing
 * invariant: every assistant `tool_use` block must be immediately followed by a
 * user message carrying a `tool_result` for each of those ids, and every
 * `tool_result` must have a matching `tool_use` in the immediately preceding
 * assistant message. Violating it is a hard 400 that aborts the whole turn.
 *
 * The agent loop builds messages correctly, but context compaction
 * (`compressContext`) reorders/drops messages and can split a pair across the
 * head/middle or middle/tail boundary. `safeHeadEnd`/`safeTailStart` snap those
 * boundaries off a pair; `repairToolPairing` is the defensive net applied right
 * before every send. See the array-level analogue of `projectAssistantText`
 * (lib/aegis/loop.ts), which does the same for a single response's blocks.
 */

/** True if this is an assistant turn carrying ≥1 `tool_use` block. */
export function hasToolUse(m: ProviderMessageParam): boolean {
  return (
    m.role === 'assistant' &&
    Array.isArray(m.content) &&
    m.content.some((b) => b.type === 'tool_use')
  );
}

/** The `tool_use` ids in a message (empty unless it's a tool-call turn). */
function toolUseIds(m: ProviderMessageParam): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(m.content)) return ids;
  for (const b of m.content) if (b.type === 'tool_use') ids.add(b.id);
  return ids;
}

/** The `tool_result` tool_use_ids in a message (empty unless it carries results). */
function toolResultIds(m: ProviderMessageParam): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(m.content)) return ids;
  for (const b of m.content) if (b.type === 'tool_result') ids.add(b.tool_use_id);
  return ids;
}

/**
 * Smallest safe end index for the head slice (`messages.slice(0, end)`): extend
 * forward while the last kept message is a `tool_use` turn, so the head never
 * ENDS on a dangling `tool_use` (its `tool_result` message gets pulled in too).
 */
export function safeHeadEnd(messages: ProviderMessageParam[], anchor: number): number {
  let end = anchor;
  while (end > 0 && end < messages.length && hasToolUse(messages[end - 1])) {
    end += 1;
  }
  return end;
}

/**
 * Largest safe start index for the tail slice (`messages.slice(start)`): extend
 * backward while the tail would BEGIN on a message carrying `tool_result` blocks
 * (whose `tool_use` is in the compressed middle), pulling the owning assistant
 * turn into the tail.
 */
export function safeTailStart(messages: ProviderMessageParam[], start: number): number {
  let s = start;
  while (s > 0 && s < messages.length && toolResultIds(messages[s]).size > 0) {
    s -= 1;
  }
  return s;
}

/**
 * Defensive repair: drop blocks that would trigger the pairing 400.
 *   - `tool_use` blocks in an assistant message NOT matched by a `tool_result`
 *     in the next message;
 *   - `tool_result` blocks whose id has no `tool_use` in the previously emitted
 *     assistant message.
 * Messages emptied by the drop are removed. String-content messages pass
 * through untouched. Idempotent.
 */
export function repairToolPairing(
  messages: ProviderMessageParam[],
): ProviderMessageParam[] {
  const out: ProviderMessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }

    if (m.role === 'assistant') {
      const next = messages[i + 1];
      const resultIds = next ? toolResultIds(next) : new Set<string>();
      const kept = m.content.filter((b) => b.type !== 'tool_use' || resultIds.has(b.id));
      if (kept.length > 0) out.push({ ...m, content: kept });
      // else: tool_use-only turn with no following results → drop the message.
      continue;
    }

    // User message: keep a tool_result only if the PREVIOUSLY EMITTED assistant
    // actually has the matching tool_use (correct even if an assistant turn was
    // just dropped above).
    const prev = out[out.length - 1];
    const useIds = prev && prev.role === 'assistant' ? toolUseIds(prev) : new Set<string>();
    const kept = m.content.filter((b) => b.type !== 'tool_result' || useIds.has(b.tool_use_id));
    if (kept.length > 0) out.push({ ...m, content: kept });
    // else: orphaned tool_result-only user turn → drop the message.
  }
  return out;
}

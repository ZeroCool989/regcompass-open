import type Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS, type ModelId } from '../types';
import { MemoryConfig } from '../memory-config';
import type { ClaudeUsage } from './cost';
import { safeHeadEnd, safeTailStart } from './tool-pairing';

/**
 * Injectable Haiku call. Identical shape to `CallModelFn` in `router.ts` so the
 * `client.ts` adapter can satisfy both contracts.
 */
export type CompressCallFn = (params: {
  model: ModelId;
  prompt: string;
  maxTokens: number;
}) => Promise<{ text: string; usage?: ClaudeUsage }>;

const COMPRESS_SYSTEM = `You are compacting the middle of a long regulatory-analysis conversation.
Produce a dense summary (≤500 tokens) that PRESERVES — verbatim where possible — every load-bearing element:
- Major decisions and conclusions reached
- Open tasks / unanswered questions still in flight
- Risk ratings and severity assessments (e.g. Critical/High/Medium/Low)
- Generated findings and gap-analysis results (statuses, counts, gap descriptions)
- Every requirement ID (format R-XXXX-NNN) and regulation/article reference
- Tool conclusions (search_kb / analyze_document / fill_template outcomes, including any download id or filename)
Do NOT drop any of the above. Omit only small talk and redundant restatements.
No commentary, no opening/closing remarks — just the summary.`;

/**
 * Compress a conversation history by keeping anchors at both ends and
 * summarising the middle with Haiku.
 *
 * Strategy (Spec §4.6):
 *   - Keep the first 2 messages (initial user pair sets the topic).
 *   - Keep the last `keepLast` messages (recent turn-by-turn context).
 *   - Replace the middle with a single synthetic user message containing the
 *     Haiku-generated summary, prefixed with `<<COMPRESSED HISTORY>>`.
 *
 * If `callHaiku` throws or the response is empty, fall back to a hard truncation
 * (drop the middle entirely) so the loop can still progress.
 *
 * No-op when the history is already short enough (≤ 2 + keepLast).
 */
export async function compressContext(
  messages: Anthropic.MessageParam[],
  keepLast: number,
  callHaiku: CompressCallFn,
  onUsage?: (usage: ClaudeUsage) => void,
): Promise<Anthropic.MessageParam[]> {
  const anchor = MemoryConfig.compactionKeepFirst;
  if (messages.length <= anchor + keepLast) {
    return messages;
  }

  // Snap both boundaries off any tool_use↔tool_result pair so the head never
  // ends on a dangling tool_use and the tail never begins on an orphaned
  // tool_result (either would make Anthropic 400 on the next send).
  const headEnd = safeHeadEnd(messages, anchor);
  const tailStart = safeTailStart(messages, Math.max(messages.length - keepLast, headEnd));
  // Snapping can collapse the middle to nothing — then there's nothing safe to
  // compress without breaking a pair, so leave the history untouched this turn.
  if (tailStart <= headEnd) {
    return messages;
  }

  const head = messages.slice(0, headEnd);
  const middle = messages.slice(headEnd, tailStart);
  const tail = messages.slice(tailStart);

  const middleText = serializeMiddle(middle);
  let summary: string;

  try {
    const { text, usage } = await callHaiku({
      model: MODEL_IDS.haiku,
      prompt: `${COMPRESS_SYSTEM}\n\nConversation segment:\n${middleText}`,
      maxTokens: 800,
    });
    if (usage) onUsage?.(usage);
    summary = text.trim();
    if (summary.length < 20) {
      // Suspiciously short summary — fall back.
      return [...head, ...tail];
    }
  } catch {
    // Fallback: drop the middle entirely. Loop continues with less context.
    return [...head, ...tail];
  }

  const compressed: Anthropic.MessageParam = {
    role: 'user',
    content: `<<COMPRESSED HISTORY>>\n${summary}`,
  };
  return [...head, compressed, ...tail];
}

function serializeMiddle(messages: Anthropic.MessageParam[]): string {
  return messages
    .map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => {
                if ('text' in b && typeof b.text === 'string') return b.text;
                if (b.type === 'tool_use') return `[tool_call: ${b.name}]`;
                if (b.type === 'tool_result') {
                  return `[tool_result: ${typeof b.content === 'string' ? b.content.slice(0, 200) : '...'}]`;
                }
                return '';
              })
              .join('\n');
      return `[${m.role}] ${content}`;
    })
    .join('\n\n');
}

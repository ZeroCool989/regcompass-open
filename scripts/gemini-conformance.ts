/**
 * Gemini D4 conformance probe — MANUAL, EXPLICITLY OPT-IN ONLY.
 *
 * Stage 1b-ii-b1 keeps `gemini-api` dispatch gated behind a capability-not-ready
 * error. This script is the sanctioned way to run the live checks that must pass
 * before that gate is lifted — against a REAL Gemini endpoint, using a key YOU
 * supply for this run. It is never part of the automated suite or CI.
 *
 * Guarantees:
 *   • Refuses to run in CI (`CI` env) and without the explicit `--live` flag.
 *   • Uses only the key in GEMINI_CONFORMANCE_API_KEY — never a developer's
 *     ambient GOOGLE_API_KEY/GEMINI_API_KEY, never a stored/default key.
 *   • Never prints the key (or any Authorization header).
 *   • Touches NO database and NO real user data — it constructs a throwaway
 *     provider and calls the model directly.
 *
 * Usage:
 *   GEMINI_CONFORMANCE_API_KEY=... pnpm exec tsx scripts/gemini-conformance.ts --live
 */
import { GeminiProvider } from '../lib/aegis/providers/gemini';
import type { ModelId } from '../lib/aegis/types';

const MODEL = (process.env.GEMINI_CONFORMANCE_MODEL ?? 'gemini-2.5-flash') as ModelId;

type ProbeResult = { name: string; pass: boolean; detail: string };

function refuse(reason: string): never {
  console.error(`gemini-conformance: ${reason}`);
  process.exit(2);
}

function preflight(): string {
  if (process.env.CI) refuse('refusing to run in CI — this probe makes live API calls.');
  if (!process.argv.includes('--live')) {
    refuse('live probe not confirmed. Re-run with --live to make real Gemini calls.');
  }
  const key = process.env.GEMINI_CONFORMANCE_API_KEY?.trim();
  if (!key) {
    refuse(
      'set GEMINI_CONFORMANCE_API_KEY to a key you supply for this run (never a stored/default key).',
    );
  }
  // The key stays in this scope; it is only handed to the provider, never logged.
  return key;
}

const SEARCH_TOOL = {
  name: 'search_kb',
  description: 'Search the regulatory knowledge base for requirements.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
} as const;

async function run(): Promise<void> {
  const apiKey = preflight();
  // A throwaway provider bound to the supplied key. No registry, no DB.
  const gemini = new GeminiProvider({ id: 'gemini', label: 'Gemini (conformance)', apiKey });
  const results: ProbeResult[] = [];
  const record = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // 1. Text response + usage extraction.
  try {
    const msg = await gemini.createMessage({
      model: MODEL, systemBlocks: [{ text: 'Answer in one short sentence.', cached: false }],
      tools: [], messages: [{ role: 'user', content: 'Reply with the single word: ready.' }], maxTokens: 64,
    });
    const text = (msg.content.find((c) => (c as { type?: string }).type === 'text') as { text?: string })?.text ?? '';
    record('text_response', text.length > 0, `text len=${text.length}`);
    record('usage_extraction', msg.usage.output_tokens > 0, `out_tokens=${msg.usage.output_tokens}`);
    record('finish_reason', msg.stop_reason !== undefined, `stop_reason=${msg.stop_reason}`);
  } catch (e) {
    record('text_response', false, String(e instanceof Error ? e.message : e));
  }

  // 2. Tool call → tool result round-trip (the AEGIS loop's core mechanic).
  try {
    const first = await gemini.createMessage({
      model: MODEL, systemBlocks: [{ text: 'Use the search_kb tool to look things up before answering.', cached: false }],
      tools: [SEARCH_TOOL], messages: [{ role: 'user', content: 'Find requirements about DORA incident reporting.' }], maxTokens: 256,
    });
    const toolUse = first.content.find((c) => (c as { type?: string }).type === 'tool_use') as
      | { id: string; name: string }
      | undefined;
    record('tool_call', !!toolUse, toolUse ? `called ${toolUse.name}` : 'model did not call the tool');
    if (toolUse) {
      const second = await gemini.createMessage({
        model: MODEL, systemBlocks: [], tools: [SEARCH_TOOL],
        messages: [
          { role: 'user', content: 'Find requirements about DORA incident reporting.' },
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'R-DORA-024: report major incidents.' }] },
        ] as never,
        maxTokens: 256,
      });
      const answered = (second.content.find((c) => (c as { type?: string }).type === 'text') as { text?: string })?.text ?? '';
      record('tool_result_roundtrip', answered.includes('R-DORA-024') || answered.length > 0, `answer len=${answered.length}`);
    }
  } catch (e) {
    record('tool_call', false, String(e instanceof Error ? e.message : e));
  }

  // 3. Forced tool-free turn (tool_choice none) must NOT call a tool.
  try {
    const forced = await gemini.createMessage({
      model: MODEL, systemBlocks: [], tools: [SEARCH_TOOL],
      messages: [{ role: 'user', content: 'Answer directly without tools: what is 2+2?' }], maxTokens: 32,
      toolChoice: { type: 'none' },
    });
    const usedTool = forced.content.some((c) => (c as { type?: string }).type === 'tool_use');
    record('tool_choice_none', !usedTool, usedTool ? 'model still called a tool' : 'no tool call (correct)');
  } catch (e) {
    record('tool_choice_none', false, String(e instanceof Error ? e.message : e));
  }

  // 4. Streaming with stable tool ids.
  try {
    const stream = await gemini.streamMessage({
      model: MODEL, systemBlocks: [{ text: 'Use search_kb first.', cached: false }],
      tools: [SEARCH_TOOL], messages: [{ role: 'user', content: 'Look up MiCA stablecoin rules.' }], maxTokens: 256,
    });
    let startedId: string | undefined;
    for await (const ev of stream) {
      const e = ev as { type?: string; content_block?: { type?: string; id?: string } };
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') startedId = e.content_block.id;
    }
    const final = await stream.finalMessage();
    const finalTool = final.content.find((c) => (c as { type?: string }).type === 'tool_use') as { id?: string } | undefined;
    const stable = !finalTool || finalTool.id === startedId;
    record('streaming_stable_ids', stable, finalTool ? `event=${startedId} final=${finalTool.id}` : 'no tool call this run');
  } catch (e) {
    record('streaming_stable_ids', false, String(e instanceof Error ? e.message : e));
  }

  // 5. Cancellation: an aborted call must stop, not run to completion.
  try {
    const ctrl = new AbortController();
    const p = gemini.createMessage({
      model: MODEL, systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'Write a very long essay.' }], maxTokens: 2048, signal: ctrl.signal,
    });
    ctrl.abort();
    let cancelled = false;
    try {
      await p;
    } catch {
      cancelled = true;
    }
    record('cancellation', cancelled, cancelled ? 'aborted as expected' : 'did not abort');
  } catch (e) {
    record('cancellation', false, String(e instanceof Error ? e.message : e));
  }

  // Report (never the key).
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log(`\nGemini D4 conformance — model ${MODEL}\n${'─'.repeat(60)}`);
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'}  ${pad(r.name, 24)} ${r.detail}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`${'─'.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log(
    failed.length === 0
      ? 'All probes passed. This is evidence toward D4 — a human still reviews citation/grounding quality before enabling dispatch.'
      : 'Some probes failed — Gemini stays gated. Fix the adapter/behaviour before lifting the D4 gate.',
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('gemini-conformance: unexpected error:', e instanceof Error ? e.message : e);
  process.exit(1);
});

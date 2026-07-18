# AEGIS Phase 1 — Implementation Specification

> **Historical spec (2026-05-25).** Phase 1 shipped; details below may
> deviate from the current implementation. The `assess_risk`/`lib/scoring/`
> plan referenced in §Executor was never built — see
> [docs/aegis/ARCHITECTURE.md](../../aegis/ARCHITECTURE.md) for current state.

> **Status:** Spec v1 · **Datum:** 2026-05-25 · **Parent:** [docs/aegis/ARCHITECTURE.md](../../aegis/ARCHITECTURE.md)
> **Scope:** Harness Core — Router, Guardrails, 5 Tools, Verify, `POST /api/aegis`, Tests
> **Out of Scope:** Auth, Persistenz, Voice, Reports, UI (Phasen 2–5)
> **Time-box:** 2–3 Entwicklertage

## 1. Definition of Done

Phase 1 ist abgeschlossen, wenn:

| # | Kriterium | Messmethode |
|---|---|---|
| D1 | `POST /api/aegis` antwortet für alle 4 Modes mit valider Response | curl + Snapshot-Test |
| D2 | Verify-Pass-Rate auf Golden Conversations ≥ 95 % | `pnpm test lib/aegis` |
| D3 | Durchschnitts-Cost pro Conversation < $0.10 | Cost-Accumulator-Log |
| D4 | p95 Latency für 1-Tool-Call-Turn < 6 s lokal | Manual bench |
| D5 | Agent zitiert ausschließlich KB-IDs aus Tool-Results | Verify-Check `citation_coverage` |
| D6 | Tool-Aufrufe ohne Internet/FS-Zugang möglich (keine fetch/fs-Imports in `lib/aegis/tools/`) | Lint-Rule + Code-Review |
| D7 | `pnpm test`, `npx tsc --noEmit`, `npx next build` grün | CI lokal |

---

## 2. Public API

### 2.1 HTTP-Endpunkt

```
POST /api/aegis
Content-Type: application/json
```

**Request Body (Zod-validiert):**

```ts
{
  mode: 'ASSESS' | 'GAP_ANALYZE' | 'CONTROL_ADVISE' | 'CONVERSATIONAL';
  message: string;                          // min 5, max 8000 chars
  conversationId?: string;                  // client-generated UUID; echoed back
  language?: 'de' | 'en';                   // default 'de'
  history?: Array<{                         // optional, client liefert (stateless Phase 1)
    role: 'user' | 'assistant';
    content: string;
    citedIds?: string[];                    // nur bei assistant
  }>;
}
```

**Success Response (`200`):**

```ts
{
  text: string;                             // sichtbare Agent-Antwort
  citations: string[];                      // KB-Requirement-IDs im Text
  conversationId: string;                   // echo
  modelUsed: string;                        // z. B. 'claude-sonnet-4-6'
  iterations: number;                       // Tool-Use-Roundtrips
  toolCalls: Array<{ name: string; input: unknown; resultPreview: string }>;
  cost: { inputTokens: number; outputTokens: number; cachedTokens: number; usd: number };
  verify: { ok: true; checks: Record<string, 'pass'> };
}
```

**Error Responses:**

| Status | `error` Code | Trigger |
|---|---|---|
| `400` | `invalid_input` | Zod-Validation fehlgeschlagen |
| `429` | `rate_limited` | 30 Aegis-Calls/h pro IP-Hash überschritten |
| `422` | `verify_failed` | 3 Outer-Loop-Attempts ohne Verify-Pass |
| `408` | `iteration_limit` | Inner-Loop >10 Iterationen |
| `402` | `cost_limit` | >$5 in Conversation kumuliert |
| `502` | `upstream_error` | Anthropic API non-retryable Error |
| `500` | `internal_error` | Unerwarteter Fehler (siehe Logs) |

Error-Body-Schema: `{ error: <code>, message: string, conversationId?: string }`.

### 2.2 Programmatische API (`lib/aegis/index.ts`)

```ts
export async function runAegis(req: AegisRequest): Promise<AegisResponse>;
export type { AegisRequest, AegisResponse, Mode, VerifyResult } from './types';
```

Aufruf von außerhalb `lib/aegis/` darf **nur** über `runAegis` erfolgen. Andere Module sind interne Implementation-Details.

---

## 3. Type-Vertrag (`lib/aegis/types.ts`)

```ts
import { z } from 'zod';

export const Mode = z.enum(['ASSESS', 'GAP_ANALYZE', 'CONTROL_ADVISE', 'CONVERSATIONAL']);
export type Mode = z.infer<typeof Mode>;

export const AegisRequest = z.object({
  mode: Mode,
  message: z.string().min(5).max(8000),
  conversationId: z.string().uuid().optional(),
  language: z.enum(['de', 'en']).default('de'),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    citedIds: z.array(z.string()).optional(),
  })).max(40).default([]),
});
export type AegisRequest = z.infer<typeof AegisRequest>;

export type ToolName =
  | 'search_kb'
  | 'get_crosswalk'
  | 'assess_risk'
  | 'generate_report'      // stubbed Phase 1
  | 'analyze_document';    // stubbed Phase 1

export type ToolCall = { id: string; name: ToolName; input: unknown };
export type ToolResult = { tool_use_id: string; content: string; is_error?: boolean };

export type VerifyCheck =
  | 'citation_coverage'
  | 'no_hallucinated_regulations'
  | 'language_consistency'
  | 'non_empty_response'
  | 'no_false_ignorance';

export type VerifyResult =
  | { ok: true;  checks: Record<VerifyCheck, 'pass'> }
  | { ok: false; failed: VerifyCheck; reason: string; feedback: string };

export type CostBreakdown = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  usd: number;
};

export type AegisResponse = {
  text: string;
  citations: string[];
  conversationId: string;
  modelUsed: string;
  iterations: number;
  toolCalls: Array<{ name: ToolName; input: unknown; resultPreview: string }>;
  cost: CostBreakdown;
  verify: VerifyResult;
};

export type AegisErrorCode =
  | 'invalid_input'
  | 'rate_limited'
  | 'verify_failed'
  | 'iteration_limit'
  | 'cost_limit'
  | 'upstream_error'
  | 'internal_error';

export class AegisError extends Error {
  constructor(public code: AegisErrorCode, message: string, public conversationId?: string) {
    super(message);
  }
}
```

---

## 4. Module-Spezifikationen

### 4.1 `lib/aegis/client.ts` — Anthropic Wrapper

Verantwortlich für **alle** Calls zur Anthropic API. Nirgends sonst darf `new Anthropic()` instanziiert werden.

```ts
import Anthropic from '@anthropic-ai/sdk';

export type ClaudeCallParams = {
  model: string;
  systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
};

export async function callClaude(params: ClaudeCallParams): Promise<Anthropic.Message>;
```

**Anforderungen:**
- Singleton Anthropic-Client (modul-lokal, lazy init).
- Setze `cache_control: { type: 'ephemeral' }` auf den letzten Block in `systemBlocks` und auf das letzte Tool in `tools` (Anthropic-Convention für Caching der statischen Präfixe).
- `max_tokens` defaultet auf 1024 (Voice-Mode), 2048 (Conversational), 4096 (alle anderen Modes — über Caller).
- Retry-Policy: `1x retry` bei 429/503 mit 1 s Backoff, sonst `throw AegisError('upstream_error')`.
- Logging: strukturiert auf `console.info` mit `{ event: 'claude_call', model, inputTokens, outputTokens, cachedTokens, durationMs }`.

### 4.2 `lib/aegis/router.ts` — Modell-Wahl

```ts
import type { Mode } from './types';

export const MODELS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

export function selectModel(mode: Mode, message: string, history: { role: string }[]): ModelId;
```

**Logik:**

| Mode | Default | Eskalations-Heuristik |
|---|---|---|
| `ASSESS` | `sonnet` | — |
| `GAP_ANALYZE` | `sonnet` | — |
| `CONTROL_ADVISE` | `opus` | — |
| `CONVERSATIONAL` | `haiku` | → `sonnet` wenn `message.length > 280` *oder* `history.length > 4` *oder* enthält `crosswalk\|gap\|recommend\|empfehl\|kontrolle` (case-insensitive) |

Eskalation darf **nur** in `CONVERSATIONAL` greifen. Andere Modes bleiben auf ihrem Default; das schützt Cost-Vorhersagbarkeit für die strukturierten Modes.

### 4.3 `lib/aegis/modes.ts` & `lib/aegis/prompts/`

```ts
// modes.ts
export type ModeSpec = {
  systemBlocks: Array<{ text: string; cached: boolean }>;
  defaultTools: ToolName[];
  maxTokens: number;
  maxIterations: number;
};

export function getModeSpec(mode: Mode, language: 'de' | 'en'): ModeSpec;
```

**Mode-Specs:**

| Mode | Tools | maxTokens | maxIter |
|---|---|---:|---:|
| `ASSESS` | `search_kb`, `assess_risk`, `get_crosswalk` | 4096 | 10 |
| `GAP_ANALYZE` | `search_kb`, `get_crosswalk`, `analyze_document` | 4096 | 10 |
| `CONTROL_ADVISE` | `search_kb`, `get_crosswalk` | 4096 | 10 |
| `CONVERSATIONAL` | `search_kb`, `get_crosswalk` | 2048 | 10 |

**Prompt-Struktur** (`prompts/identity.ts` + `prompts/mode_*.ts`):

`systemBlocks[0]` = Identity (cached, **statisch** — gleich für alle Requests):
```
You are AEGIS, the RegCompass interactive compliance advisor.

HARD RULES — violations cause your response to be rejected:
1. You ONLY answer based on results from the provided tools. If a tool returns no relevant requirement, say so explicitly.
2. EVERY claim about a regulation MUST cite a requirement ID like [R-XXXX-NNN]. Only use IDs that appeared in your tool results.
3. You NEVER invent article numbers, fines, deadlines, or authorities.
4. You NEVER provide legal advice. You explain regulatory obligations as defined in the RegCompass knowledge base.
5. You distinguish binding levels: mandatory (law), supervisory_expectation, best_practice.

KB version: 2026-05-25 — 265 requirements, 160 controls, 19 regulations across EU/CH/DE/INTL.

When you don't know: say "Dies wird von der aktuellen Wissensbasis nicht abgedeckt." (DE) or "This is not covered by the current knowledge base." (EN). Never extrapolate.
```

`systemBlocks[1]` = Mode-Anweisung (cached, **per-mode statisch**):
- `ASSESS`: „Use `assess_risk` first; then explain the result with citations."
- `GAP_ANALYZE`: „Read the document via `analyze_document`; map findings to KB requirements; return a gap matrix."
- `CONTROL_ADVISE`: „For each gap given, search KB controls and return concrete implementation steps."
- `CONVERSATIONAL`: „Answer the user's question succinctly using `search_kb`. Cite every fact."

`systemBlocks[2]` = Language directive (**nicht** cached, da pro Request):
- DE: „Antworte auf Deutsch."
- EN: „Respond in English."

**Cache-Strategie:** Cache-Markierung **nur** auf den letzten Identity-Block + letztes Tool. Mode-Block bleibt zwischen identischen Modes wiederverwendbar; Anthropic-Cache erkennt Präfix-Match.

### 4.4 `lib/aegis/tools/` — Tool-Registry

**`tools/index.ts`:**
```ts
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ToolCall, ToolResult, ToolName } from '../types';

export const TOOL_SCHEMAS: Record<ToolName, Anthropic.Tool>;
export async function executeTool(call: ToolCall): Promise<ToolResult>;
```

**Anthropic Tool-Schemas (Phase 1):**

```jsonc
// search_kb
{
  "name": "search_kb",
  "description": "Search the RegCompass knowledge base for regulatory requirements. Returns up to 10 matching requirements with their ID, title, regulation, article, summary, bindingLevel, and audience.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Free-text query in DE or EN. Searched in title, summary, id, tags, and control actions." },
      "regulation": { "type": "string", "enum": ["EU_AI_ACT","DORA","GDPR","NIS2","DSA","DATA_ACT","PRODUCT_LIABILITY","FINMA_08_2024","FINMA_RS_2023_1","FINMA_RS_2018_3","REVDSG","BDSG","BSIG","MARISK","BAIT","ISO_42001","ISO_42005","ISO_23894","NIST_AI_RMF"] },
      "jurisdiction": { "type": "string", "enum": ["EU","CH","DE","INTL"] },
      "bindingLevel": { "type": "string", "enum": ["mandatory","supervisory_expectation","best_practice"] },
      "audience": { "type": "string", "enum": ["provider","deployer","authority","all","gpai-provider","importer","distributor","authorised-representative","financial-entity","ict-third-party-provider"] },
      "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
    },
    "required": ["query"]
  }
}

// get_crosswalk
{
  "name": "get_crosswalk",
  "description": "Returns cross-regulation mapping entries. Filter by topic or by a specific requirement ID to find overlapping obligations.",
  "input_schema": {
    "type": "object",
    "properties": {
      "topic": { "type": "string" },
      "requirementId": { "type": "string", "pattern": "^R-[A-Z0-9]+-[A-Z0-9-]+$" }
    }
  }
}

// assess_risk
{
  "name": "assess_risk",
  "description": "Run the deterministic RegCompass scoring engine on a structured AI use case description. Returns tier (minimal/limited/high/prohibited), score 0-100, triggered rules, and affected requirement IDs.",
  "input_schema": { /* identical to AssessmentInput Zod schema in lib/scoring/types.ts */ }
}

// generate_report — Phase 4, but registered + stubbed
{
  "name": "generate_report",
  "description": "PLACEHOLDER — not yet implemented in Phase 1. Returns an error directing the agent to summarize in-line.",
  "input_schema": { "type": "object", "properties": {}, "additionalProperties": true }
}

// analyze_document — Phase 4, but registered + stubbed
{
  "name": "analyze_document",
  "description": "PLACEHOLDER — not yet implemented in Phase 1. Returns an error directing the agent to ask the user for structured input instead.",
  "input_schema": { "type": "object", "properties": {}, "additionalProperties": true }
}
```

**Executor-Verhalten:**

- `search_kb`: wraps `KB.search(query)` aus [lib/kb/index.ts](../../../lib/kb/index.ts), wendet Filter sequentiell an, sortiert mit dem Reranking aus ADR §6.1, slice auf `limit`. Liefert JSON-Array von Requirements **ohne** `body`-Feld (Token-Sparen — der Agent kann via `search_kb` mit der ID erneut suchen, falls Detail nötig).
- `get_crosswalk`: filter `KB.crosswalk` auf `topic` (substring, case-insensitive) und/oder `requirementId` (`entry.requirements.includes`).
- `assess_risk`: wraps `score()` aus `lib/scoring/engine.ts` *(nie gebaut — historischer Plan, siehe Banner oben)*. KB-Version wird automatisch von der Engine bezogen.
- `generate_report` / `analyze_document`: liefern `{ is_error: true, content: "Tool not yet implemented in Phase 1. Please summarize results in your response instead." }`.

**Hard Boundary (Lint-Rule, siehe Test T6):**
- `lib/aegis/tools/*.ts` darf **nicht** `fetch`, `import 'fs'`, `import 'node:fs'`, `import 'child_process'` oder vergleichbares importieren.
- Verifizierbar via `grep -rn "fetch\|from 'fs'\|from 'node:fs'\|child_process" lib/aegis/tools/` → muss leer sein.

### 4.5 `lib/aegis/guardrails/`

**`pre.ts`:**

```ts
export type PreGuardContext = {
  iteration: number;
  costUsd: number;
  conversationLength: number;
  message: string;
};
export type PreGuardResult =
  | { action: 'ok' }
  | { action: 'compress' }
  | { action: 'kill'; code: 'iteration_limit' | 'cost_limit' };

export function applyPreGuards(ctx: PreGuardContext, maxIter: number): PreGuardResult;
export function sanitizeUserMessage(input: string): string;
```

**Regeln:**
- `iteration > maxIter` → `kill('iteration_limit')`
- `costUsd > 5.00` → `kill('cost_limit')`
- `conversationLength > 20` → `compress` (wird vom Loop konsumiert)
- Prompt-Injection-Sanitization: ersetze Patterns `ignore previous instructions`, `ignore all rules`, `system:` (case-insensitive) durch `[redacted]`; nutze [lib/sanitize.ts](../../../lib/sanitize.ts) für HTML/Tag-Strip.

**`post.ts`:**

```ts
export type PostGuardResult = { text: string; warnings: string[] };
export function applyPostGuards(text: string): PostGuardResult;
```

**Regeln:**
- **Banned phrases** (DE+EN, case-insensitive, ganzer Satz wird entfernt; trailing Whitespace getrimmt):
  - `\b(rechtsberatung|legal advice|rechtsverbindlich)\b`
  - `\bI recommend you should\b`
  - `\bI strongly advise\b`
- **Citation Warning** (kein Strip, nur `warnings.push`): Regex `\b(Art\.|§|Rz\.|Kap\.)\s*\d` ohne folgendes `[R-` im selben Absatz.
- **Empty-after-strip**: wenn `text.trim().length < 10`, gib unveränderten Original-Text zurück und warne (Verify wird `non_empty_response` greifen lassen).

### 4.6 `lib/aegis/context/`

**`cost.ts`:**

```ts
export const MODEL_PRICING: Record<ModelId, { inUsdPerMTok: number; outUsdPerMTok: number; cachedInUsdPerMTok: number }>;
export function addCost(acc: CostBreakdown, usage: { input: number; output: number; cached: number }, model: ModelId): CostBreakdown;
```

Preise (**Annahme — siehe ADR §11 R1 vor Produktion verifizieren**):
- Haiku 4.5: `{ in: 1, out: 5, cached: 0.10 }`
- Sonnet 4.6: `{ in: 3, out: 15, cached: 0.30 }`
- Opus 4.7: `{ in: 5, out: 25, cached: 0.50 }` (Brief-Werte; siehe ADR-Vorbehalt)

**`compress.ts`:**

```ts
export async function compressHistory(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]>;
```

- Wird nur aufgerufen, wenn `messages.length > 20`.
- Behält: erstes User-Pair (`messages[0..1]`) + letzte 4 Messages.
- Mittelteil → Haiku-Call (`callClaude` mit `model: MODELS.haiku, maxTokens: 300`) mit System-Prompt: „Summarize this conversation segment into ≤200 tokens. Preserve any requirement IDs (R-XXXX-NNN) mentioned. No commentary."
- Resultat als synthetische `{ role: 'user', content: '<<COMPRESSED HISTORY>>\n' + summary }` Message in der Mitte einfügen.

### 4.7 `lib/aegis/verify.ts` — Deterministische Prüfung

```ts
export type VerifyInput = {
  text: string;
  allowedIds: Set<string>;          // Union aller KB-IDs aus Tool-Results
  toolsCalled: number;
  language: 'de' | 'en';
};
export function verify(input: VerifyInput): VerifyResult;
```

**Implementierungen der 5 Checks:**

1. **`citation_coverage`** — Iteriere Paragraphen (split `\n\n+`). Für jeden Paragraphen: zähle Matches von `\b(Art\.|§|Rz\.|Kap\.)\s*\d+` und Matches von `\[R-[A-Z0-9]+-[A-Z0-9-]+\]`. Falls Article-Matches > 0 und ID-Matches == 0 → `fail`. Feedback: „Paragraph references regulation articles without a matching [R-...] citation: '<excerpt>'".

2. **`no_hallucinated_regulations`** — Erstelle `KNOWN = new Set(KB.regulations.map(r => r.shortName.toLowerCase()))` (modul-konstant). Extrahiere alle Substrings, die Regulationsnamen sein könnten (regex `\b(EU AI Act|DORA|GDPR|NIS2|DSA|Data Act|FINMA[^\s,.]+|MaRisk|BAIT|BDSG|BSIG|revDSG|ISO ?\d{4,5}|NIST[^\s,.]+|Product Liability)\b`). Jeder Match (lowercased, normalized whitespace) muss in `KNOWN` sein. Sonst `fail`. Feedback nennt den unbekannten Begriff.

3. **`language_consistency`** — Heuristisch: zähle Vorkommen typischer Funktionswörter pro Sprache in Top-200-Tokens (`text.split(/\s+/).slice(0, 200)`). DE-Marker: `der|die|das|und|nicht|für|sind|werden`. EN-Marker: `the|and|of|to|is|are|that|with`. Dominante Sprache muss `language` matchen. Andernfalls `fail` mit Feedback: „Response language mismatch: expected `<x>`."

4. **`non_empty_response`** — `text.trim().length < 10` → `fail`. Feedback: „Response was too short."

5. **`no_false_ignorance`** — Falls `toolsCalled > 0` und der Text enthält `dies wird von der aktuellen wissensbasis nicht abgedeckt` (lowercased) ODER `this is not covered by the current knowledge base` → `fail` (vorausgesetzt mindestens 1 Tool-Result lieferte ≥1 Item; das ist die Job-Annahme des Callers, der `toolsCalled` setzt). Feedback: „You called tools that returned results — do not claim ignorance."

Verify gibt **die erste fehlschlagende Prüfung** zurück, nicht alle. Reihenfolge der Checks = Reihenfolge oben.

### 4.8 `lib/aegis/loop.ts` — Agent Loop

```ts
export type LoopState = {
  messages: Anthropic.MessageParam[];
  iteration: number;
  cost: CostBreakdown;
  toolCalls: AegisResponse['toolCalls'];
  toolsCalled: number;
  allowedIds: Set<string>;
};

export async function runOuterLoop(
  spec: ModeSpec,
  initial: LoopState,
  model: ModelId,
  language: 'de' | 'en',
): Promise<{ text: string; state: LoopState; verify: VerifyResult }>;
```

**Outer Loop (max 3 Attempts):**
```
for attempt in 1..=3:
  text, state = run_inner_loop(spec, current_state, model)   // throws on kill
  v = verify({ text, allowedIds: state.allowedIds, toolsCalled: state.toolsCalled, language })
  if v.ok: return { text, state, verify: v }
  // append verify feedback as system reminder and retry
  current_state.messages.push({
    role: 'user',
    content: `[VERIFY FEEDBACK — please correct] ${v.reason}\n${v.feedback}`,
  })
throw AegisError('verify_failed', 'Could not produce a verified response in 3 attempts')
```

**Inner Loop (max `spec.maxIterations`, default 10):**
```
while state.iteration < spec.maxIterations:
  preCheck = applyPreGuards({ iteration, costUsd, conversationLength, message }, spec.maxIterations)
  if preCheck.action == 'kill': throw AegisError(preCheck.code, ...)
  if preCheck.action == 'compress': state.messages = await compressHistory(state.messages)

  response = await callClaude({
    model, systemBlocks: spec.systemBlocks, tools: schemasFor(spec.defaultTools),
    messages: state.messages, maxTokens: spec.maxTokens,
  })
  state.cost = addCost(state.cost, response.usage, model)

  if response.stop_reason == 'tool_use':
    state.iteration++
    state.messages.push({ role: 'assistant', content: response.content })
    toolResults = []
    for block in response.content where block.type == 'tool_use':
      res = await executeTool({ id: block.id, name: block.name, input: block.input })
      toolResults.push({ type: 'tool_result', tool_use_id: res.tool_use_id, content: res.content, is_error: res.is_error })
      state.toolsCalled++
      state.toolCalls.push({ name: block.name, input: block.input, resultPreview: res.content.slice(0, 200) })
      extractKbIdsFromToolResult(res.content).forEach(id => state.allowedIds.add(id))
    state.messages.push({ role: 'user', content: toolResults })
    continue

  if response.stop_reason == 'end_turn':
    text = response.content.filter(c => c.type == 'text').map(c => c.text).join('')
    { text, warnings } = applyPostGuards(text)
    return { text, state }

  throw AegisError('upstream_error', `Unexpected stop_reason: ${response.stop_reason}`)

throw AegisError('iteration_limit', `Exceeded ${spec.maxIterations} iterations`)
```

**`extractKbIdsFromToolResult(jsonString)`** = Regex `/R-[A-Z0-9]+-[A-Z0-9-]+/g` über das Tool-Result, dedupliziert.

### 4.9 `lib/aegis/index.ts` — Orchestrator

```ts
export async function runAegis(input: AegisRequest): Promise<AegisResponse> {
  const req = AegisRequest.parse(input);
  const conversationId = req.conversationId ?? crypto.randomUUID();
  const model = selectModel(req.mode, req.message, req.history);
  const spec = getModeSpec(req.mode, req.language);

  const messages = [
    ...req.history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: sanitizeUserMessage(req.message) },
  ];

  const initialState: LoopState = {
    messages, iteration: 0,
    cost: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
    toolCalls: [], toolsCalled: 0, allowedIds: new Set(),
  };

  const { text, state, verify: v } = await runOuterLoop(spec, initialState, model, req.language);

  return {
    text,
    citations: [...new Set([...text.matchAll(/\[(R-[A-Z0-9]+-[A-Z0-9-]+)\]/g)].map(m => m[1]))],
    conversationId,
    modelUsed: model,
    iterations: state.iteration,
    toolCalls: state.toolCalls,
    cost: state.cost,
    verify: v,
  };
}
```

---

## 5. API Route — `app/api/aegis/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { rateLimit } from '@/lib/rate-limit';
import { runAegis } from '@/lib/aegis';
import { AegisError } from '@/lib/aegis/types';

const aegisLimiter = rateLimit({ key: 'aegis', limit: 30, windowMs: 60 * 60 * 1000 });

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const ipHash = createHash('sha256').update(ip).digest('hex');
  const limit = aegisLimiter.check(ipHash);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Limit 30 calls/h exceeded.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  try {
    const body = await req.json();
    const result = await runAegis(body);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AegisError) {
      const statusMap: Record<string, number> = {
        invalid_input: 400, verify_failed: 422, iteration_limit: 408,
        cost_limit: 402, upstream_error: 502, internal_error: 500, rate_limited: 429,
      };
      return NextResponse.json(
        { error: err.code, message: err.message, conversationId: err.conversationId },
        { status: statusMap[err.code] ?? 500 },
      );
    }
    if (err instanceof Error && err.name === 'ZodError') {
      return NextResponse.json({ error: 'invalid_input', message: err.message }, { status: 400 });
    }
    console.error('aegis route error:', err);
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
```

Hinweis: Phase 1 nutzt das bekannt-schwache In-Memory-Rate-Limit. Phase 2 ersetzt es (siehe ADR §11 R3).

---

## 6. Test-Plan

Verzeichnis: `lib/aegis/__tests__/`. Test-Runner: vitest (bereits konfiguriert).

| ID | Datei | Was geprüft wird |
|---|---|---|
| T1 | `router.test.ts` | 12 Cases: jeder Mode in DE+EN, jede Eskalations-Heuristik in `CONVERSATIONAL` (kurz/lang, history-länge, Keywords) |
| T2 | `verify.test.ts` | 25 Cases: jeder der 5 Checks 5×: 1 happy path + 4 Failure-Varianten |
| T3 | `guardrails.test.ts` | 20 Cases: PRE (iteration/cost/compress/sanitize × 5) + POST (banned phrases DE+EN × 5, citation warning × 5, empty × 5) |
| T4 | `tools.test.ts` | 18 Cases: jedes Real-Tool 6× (Filter-Kombinationen) + 2× Stub-Tools liefern is_error |
| T5 | `loop.test.ts` | 10 Cases mit Mock-Client (`vi.mock`): tool_use → tool_use → end_turn happy path; iteration_limit; verify_failed → retry → success; verify_failed × 3 → throw |
| T6 | `boundary.test.ts` | Lint-equivalent Test: `grep`-Scan über `lib/aegis/tools/` darf keine `fetch`/`fs`/`child_process`-Imports finden |
| T7 | `golden.test.ts` | Lädt `golden_conversations.json`, ruft echten Anthropic-Endpunkt nur wenn `ANTHROPIC_API_KEY` gesetzt und `RUN_LIVE_TESTS=1`, sonst skip. ≥ 95 % Pass-Rate erforderlich |

### `golden_conversations.json` (≥ 10 Cases)

Mindest-Coverage:
- 1× `ASSESS` DE (Kreditscoring-Use-Case)
- 1× `ASSESS` EN (insurance underwriting)
- 1× `GAP_ANALYZE` DE mit zwei-Absatz-Policy-Snippet
- 1× `CONTROL_ADVISE` mit gemockten Gaps
- 2× `CONVERSATIONAL` DE: einmal short (Haiku-Route), einmal komplex (Sonnet-Eskalation)
- 2× `CONVERSATIONAL` EN
- 1× Verify-Failure-Retry: erste Antwort ohne Citations → Outer-Loop muss korrigieren
- 1× Off-topic-Anfrage („Wie ist das Wetter?") — Agent muss „nicht in der Wissensbasis"-Antwort geben

Jede Case-Definition:
```jsonc
{
  "name": "ASSESS_DE_credit_scoring",
  "input": { "mode": "ASSESS", "message": "...", "language": "de" },
  "assert": {
    "verifyOk": true,
    "minCitations": 3,
    "expectedRegulations": ["EU_AI_ACT", "MARISK"],
    "maxIterations": 6,
    "modelUsed": "claude-sonnet-4-6"
  }
}
```

---

## 7. Error-Handling Matrix

| Quelle | Anthropic-Status | AEGIS-Reaktion |
|---|---|---|
| Network timeout | — | `upstream_error` nach 1 Retry |
| 401 unauthorized | 401 | `internal_error` (Env nicht gesetzt → liegt am Deployment) |
| 429 rate-limited (Anthropic) | 429 | `upstream_error` nach 1 Retry mit 1 s Backoff |
| 400 bad request | 400 | `internal_error` (unser Prompt-Bug) |
| 5xx | 5xx | `upstream_error` nach 1 Retry |
| Tool-Executor wirft | — | Tool-Result mit `is_error: true`, Agent kann reagieren |
| Verify fehlgeschlagen ×3 | — | `verify_failed` an Client |

---

## 8. Sicherheits-Eckpfeiler

- **Kein eigener Filesystem-Zugriff in Tools** (Test T6 enforced).
- **Sanitization** auf User-Input vor Einschluss in Prompt.
- **Rate-Limit** auf API-Ebene (auch wenn schwach — siehe ADR §11 R3).
- **API-Key** nur server-seitig; Tool-Use läuft ausschließlich in der Route Handler.
- **Cost-Cap** $5/Conversation — schützt vor pathologischen Loops.
- **Keine Logs mit PII** — nur Token-Counts, Mode, Model, Cost, Iter; **kein** User-Message-Inhalt in Logs.

---

## 9. Out of Scope (explizit Phase ≥ 2)

- Persistente Konversationen (`Conversation`/`Message` Models)
- Auth/Authz (`User` Model, NextAuth)
- Streaming-Responses (kein SSE in Phase 1 — Full-Response erst)
- Persistenter Cost-Tracking (nur in-process)
- Voice-Channel
- `generate_report` und `analyze_document` echte Implementierung (Phase 4)
- pgvector / Embeddings
- Frontend-UI (Phase 5)

---

## 10. Implementierungs-Reihenfolge (Empfehlung)

1. `types.ts` + `cost.ts` + `prompts/identity.ts` + `prompts/mode_*.ts` (~30 min, kein API-Call)
2. `verify.ts` + `verify.test.ts` (~60 min, pure-function, sofort testbar)
3. `tools/index.ts` + 3 echte Tools + `tools.test.ts` (~90 min, KB-Imports)
4. `guardrails/{pre,post}.ts` + Tests (~60 min)
5. `router.ts` + `modes.ts` + Tests (~45 min)
6. `client.ts` (Anthropic Wrapper) + manueller curl-Test (~45 min)
7. `loop.ts` mit Mock-Client + Tests (~90 min)
8. `index.ts` (`runAegis`) + `app/api/aegis/route.ts` + curl-E2E (~45 min)
9. `golden_conversations.json` + `golden.test.ts` (~60 min)
10. Run `pnpm test && npx tsc --noEmit && npx next build` → grün → DONE

**Geschätzt 9–11 produktive Stunden** — passt in 2 Entwicklertage mit Puffer.

---

## 11. Abnahme-Checkliste

Vor Phase-1-Merge:

- [ ] D1–D7 aus §1 erfüllt
- [ ] Test T1–T7 alle grün
- [ ] `lib/aegis/tools/*.ts` enthält keine `fetch`/`fs`/`child_process`-Imports
- [ ] Kein `new Anthropic()` außerhalb `lib/aegis/client.ts`
- [ ] `process.env.ANTHROPIC_API_KEY` fehlend → klare Fehlermeldung, kein Crash
- [ ] curl-Demo gegen `/api/aegis` mit allen 4 Modes liefert valides JSON
- [ ] ADR §11 R1 (Opus-Pricing) entweder bestätigt oder Konstanten in `cost.ts` korrigiert
- [ ] `docs/aegis/ARCHITECTURE.md` mit Verweis auf diese Spec aktualisiert (`docs/superpowers/specs/aegis-phase-1.md`)

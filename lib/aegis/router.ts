import { KB } from '@/lib/kb';
import {
  AegisMode,
  MODEL_IDS,
  type ModelId,
} from './types';
import type { ClaudeUsage } from './context/cost';

// ───────────────────────── Intent classification ─────────────────────────

export type IntentClassification = {
  mode: AegisMode;
  /** 0.0 = trivial factual lookup, 1.0 = multi-step cross-regulation reasoning. */
  complexity: number;
};

/**
 * Minimal injectable contract for the Anthropic call inside `classifyIntent`.
 * The real wrapper lives in `lib/aegis/client.ts`; tests pass a stub.
 */
export type CallModelFn = (params: {
  model: ModelId;
  prompt: string;
  maxTokens: number;
}) => Promise<{ text: string; usage?: ClaudeUsage }>;

const FALLBACK_INTENT: IntentClassification = {
  mode: 'CONVERSATIONAL',
  complexity: 0.5,
};

const INTENT_SYSTEM = `You are an intent classifier for the RegCompass AEGIS agent.

Classify the user message into exactly one mode:
- ASSESS: user wants to assess an AI system against regulations (mentions a use case, sector, jurisdiction, attributes).
- GAP_ANALYZE: user supplies a policy document or asks for gap analysis.
- CONTROL_ADVISE: user asks for concrete control recommendations or implementation steps.
- CONVERSATIONAL: any other free-form question about regulations.

Also rate complexity from 0.0 to 1.0:
- 0.0–0.3: trivial factual lookup ("What is DORA?", "Which articles cover credit scoring?").
- 0.4–0.6: standard explanation requiring 1–2 KB lookups.
- 0.7–1.0: multi-step cross-regulation reasoning or ambiguous scope.

Return ONLY a JSON object on a single line, no other text:
{"mode":"<MODE>","complexity":<NUMBER>}`;

export async function classifyIntent(
  message: string,
  callModel: CallModelFn,
  onUsage?: (usage: ClaudeUsage) => void,
): Promise<IntentClassification> {
  try {
    const { text, usage } = await callModel({
      model: MODEL_IDS.haiku,
      prompt: `${INTENT_SYSTEM}\n\nUser message:\n${message}`,
      maxTokens: 100,
    });
    // The call was billed regardless of whether parsing below succeeds.
    if (usage) onUsage?.(usage);

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return FALLBACK_INTENT;

    const raw = JSON.parse(match[0]) as { mode?: unknown; complexity?: unknown };
    const mode = AegisMode.parse(raw.mode);
    const complexity = Number(raw.complexity);
    if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) {
      return FALLBACK_INTENT;
    }
    return { mode, complexity };
  } catch {
    return FALLBACK_INTENT;
  }
}

// ───────────────────── Heuristic complexity (3.4) ─────────────────────

/**
 * Lower-cased KB regulation short names, longest-first so multi-word names
 * ("eu ai act") match before any substring collision. Built ONCE at module
 * load — no per-request work.
 */
const REG_SHORTNAMES: string[] = KB.regulations
  .map((r) => r.shortName.toLowerCase().trim())
  .filter((s) => s.length > 0)
  .sort((a, b) => b.length - a.length);

/** Keywords that signal cross-regulation / comparative reasoning (DE + EN). */
const CROSS_REG_KEYWORDS = [
  'vs', 'versus', 'compare', 'comparison', 'difference', 'differences',
  'unterschied', 'vergleich', 'vergleiche', 'beide', 'sowohl', 'crosswalk',
  'mapping', 'überschneid', 'gegenüber',
];

/**
 * Pure, allocation-light estimate of CONVERSATIONAL complexity in [0,1] — the
 * heuristic alternative to the blocking Haiku `classifyIntent` call. Drives the
 * Haiku↔Sonnet escalation (threshold 0.5 in `routeToModel`).
 *
 * Deliberately **biased toward Sonnet when uncertain**: an ambiguous question
 * with no recognisable regulation anchor tips to escalation, because the cost of
 * under-powering a hard question outweighs a Haiku saving. We validate against
 * real queries before flipping `AEGIS_INTENT_CLASSIFIER` to 'heuristic'.
 */
export function estimateComplexity(message: string): number {
  const lower = message.toLowerCase();

  let regCount = 0;
  for (const name of REG_SHORTNAMES) {
    if (lower.includes(name)) regCount++;
  }
  const crossKeyword = CROSS_REG_KEYWORDS.some((k) => lower.includes(k));
  const qMarks = (message.match(/\?/g) ?? []).length;
  const len = message.length;

  let score = 0.3; // base — leans cautious
  if (regCount >= 2) score += 0.3; // multi-regulation reasoning
  if (crossKeyword) score += 0.25; // explicit compare / crosswalk ask
  if (len > 300) score += 0.15;
  if (len > 600) score += 0.1;
  if (qMarks > 1) score += Math.min(0.1, 0.05 * (qMarks - 1));
  // Uncertain: no regulation anchor and not a trivially short prompt → lean
  // Sonnet rather than guess Haiku.
  if (regCount === 0 && !crossKeyword && len > 140) score += 0.25;

  return Math.min(1, Math.max(0, score));
}

/**
 * Which classifier produces CONVERSATIONAL complexity. Code default is 'haiku'
 * (no routing change on deploy); we flip to 'heuristic' via env deliberately,
 * after validating the heuristic against real queries.
 */
export function getIntentClassifier(): 'haiku' | 'heuristic' {
  return process.env.AEGIS_INTENT_CLASSIFIER === 'heuristic' ? 'heuristic' : 'haiku';
}

// ───────────────────────── Model routing ─────────────────────────

// Output tokens + iteration ceilings live solely in `modes.ts`
// (MODE_MAX_TOKENS / MODE_MAX_ITERATIONS). routeToModel ONLY selects the model.
export type RouteDecision = {
  model: ModelId;
  rationale: string;
};

const ESCALATION_THRESHOLD = 0.5;

/**
 * Map (mode, complexity) → concrete model.
 * Source: docs/aegis/ARCHITECTURE.md §4 + §5.
 *
 * Eskalation greift **nur** in CONVERSATIONAL — strukturierte Modes bleiben
 * auf ihrem Default für Cost-Vorhersagbarkeit.
 */
export function routeToModel(
  mode: AegisMode,
  complexity: number,
): RouteDecision {
  switch (mode) {
    case 'ASSESS':
      return { model: MODEL_IDS.sonnet, rationale: 'ASSESS → Sonnet (default for structured assessments)' };

    case 'GAP_ANALYZE':
      return { model: MODEL_IDS.sonnet, rationale: 'GAP_ANALYZE → Sonnet (default for document mapping)' };

    case 'CONTROL_ADVISE':
      return { model: MODEL_IDS.opus, rationale: 'CONTROL_ADVISE → Opus (cross-regulation control synthesis)' };

    case 'CONVERSATIONAL': {
      const c = complexity.toFixed(2);
      if (complexity > ESCALATION_THRESHOLD) {
        return { model: MODEL_IDS.sonnet, rationale: `CONVERSATIONAL complexity ${c} > ${ESCALATION_THRESHOLD} → escalate to Sonnet` };
      }
      return { model: MODEL_IDS.haiku, rationale: `CONVERSATIONAL complexity ${c} ≤ ${ESCALATION_THRESHOLD} → Haiku` };
    }
  }
}

// ───────────────────────── User model preference (D8) ─────────────────────────

const MODEL_TIER: Record<ModelId, number> = {
  [MODEL_IDS.haiku]: 0,
  [MODEL_IDS.sonnet]: 1,
  [MODEL_IDS.opus]: 2,
};

/**
 * Overlay the user's preferred model (D8) on a routing decision.
 *
 * Applies ONLY when the turn runs on the user's own credential (BYOK,
 * `source: 'user'`) — on the system key the app's routing rules stand
 * unchanged. The mode's routed model is a quality FLOOR: a preference may
 * upgrade (user pays for it), never downgrade — so pinned modes like
 * CONTROL_ADVISE (Opus) always keep their pin. Unknown model ids are ignored
 * (defense in depth; the settings API already rejects them).
 *
 * The rationale records what happened — it flows into servedModels/audit, so
 * preference decisions stay observable.
 */
export function applyModelPreference(
  decision: RouteDecision,
  // Accepts any resolved-credential shape: BYOK rows carry modelHint/source,
  // service-key objects only an apiKey — those never match `source: 'user'`.
  credential: { apiKey?: string; modelHint?: string | null; source?: string } | null | undefined,
): RouteDecision {
  const hint = credential?.source === 'user' ? credential.modelHint : null;
  if (!hint || !(hint in MODEL_TIER)) return decision;
  const preferred = hint as ModelId;
  if (MODEL_TIER[preferred] > MODEL_TIER[decision.model]) {
    return {
      model: preferred,
      rationale: `${decision.rationale}; upgraded to user-preferred ${preferred} (BYOK)`,
    };
  }
  if (MODEL_TIER[preferred] < MODEL_TIER[decision.model]) {
    return {
      ...decision,
      rationale: `${decision.rationale}; user preference ${preferred} below mode floor — floor wins`,
    };
  }
  return decision;
}

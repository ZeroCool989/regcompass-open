import { sanitizeText } from '@/lib/sanitize';
import type {
  GuardrailCheckResult,
  GuardrailConfig,
} from '../types';

export type PreGuardState = {
  iteration: number;
  costUsd: number;
  /** Current context-window size in tokens (last prompt's input total). */
  contextTokens: number;
  message: string;
};

/**
 * Pre-flight checks before each Claude call. Order matters:
 *   1. iteration limit  → kill (cheapest check)
 *   2. cost limit       → kill
 *   3. context overflow → compress
 *   4. injection patterns → sanitize the message
 * Returns `ok` if nothing trips.
 */
export function checkPre(
  config: GuardrailConfig,
  state: PreGuardState,
): GuardrailCheckResult {
  if (state.iteration >= config.maxIterations) {
    return {
      action: 'kill',
      code: 'iteration_limit',
      detail: `Iteration ${state.iteration} reached the ceiling of ${config.maxIterations}.`,
    };
  }

  if (state.costUsd > config.maxCostUsd) {
    return {
      action: 'kill',
      code: 'cost_limit',
      detail: `Accumulated cost $${state.costUsd.toFixed(4)} exceeds the cap of $${config.maxCostUsd.toFixed(2)}.`,
    };
  }

  if (state.contextTokens > config.maxContextTokens) {
    return {
      action: 'compress',
      reason: `Context window ${state.contextTokens} tokens > ${config.maxContextTokens}.`,
    };
  }

  const matched: string[] = [];
  let sanitized = state.message;
  for (const pattern of config.bannedInputPatterns) {
    if (pattern.test(sanitized)) {
      matched.push(pattern.source);
      sanitized = sanitized.replace(pattern, '[redacted]');
    }
  }
  if (matched.length > 0) {
    return {
      action: 'sanitize',
      sanitizedMessage: sanitizeUserMessage(sanitized),
      matched,
    };
  }

  return { action: 'ok' };
}

/**
 * Apply HTML-tag stripping (from lib/sanitize) to the user message.
 * Exposed because `applyGuardrails(pre, ...)` returns sanitized text via the
 * result object, but the loop also needs a one-shot sanitizer for the initial
 * user message before the first guard check.
 */
export function sanitizeUserMessage(input: string): string {
  return sanitizeText(input);
}

import type {
  GuardrailCheckResult,
  GuardrailConfig,
} from '../types';
import { checkPre, sanitizeUserMessage, type PreGuardState } from './pre';
import { checkPost } from './post';

export type PostGuardState = {
  responseText: string;
  citations: string[];
};

/**
 * Dispatcher. Picks the right check based on `phase`. Overloaded to give
 * callers concrete state types per phase — no union narrowing in the loop.
 */
export function applyGuardrails(
  phase: 'pre',
  config: GuardrailConfig,
  state: PreGuardState,
): GuardrailCheckResult;
export function applyGuardrails(
  phase: 'post',
  config: GuardrailConfig,
  state: PostGuardState,
): GuardrailCheckResult;
export function applyGuardrails(
  phase: 'pre' | 'post',
  config: GuardrailConfig,
  state: PreGuardState | PostGuardState,
): GuardrailCheckResult {
  if (phase === 'pre') {
    return checkPre(config, state as PreGuardState);
  }
  const post = state as PostGuardState;
  return checkPost(config, post.responseText, post.citations);
}

export { checkPre, checkPost, sanitizeUserMessage };
export type { PreGuardState };

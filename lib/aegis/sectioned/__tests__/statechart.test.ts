import { describe, expect, it } from 'vitest';
import {
  assertJobTransition,
  assertSectionTransition,
  canJobTransition,
  canSectionTransition,
  InvalidTransitionError,
  jobExpiresAt,
  jobMaxResumes,
} from '../statechart';

describe('job statechart (F10)', () => {
  it.each([
    ['planning', 'running'],
    ['planning', 'failed'],
    ['running', 'paused'],
    ['running', 'done'],
    ['running', 'failed'],
    ['paused', 'running'],
    ['paused', 'failed'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canJobTransition(from, to)).toBe(true);
    expect(() => assertJobTransition(from, to)).not.toThrow();
  });

  it.each([
    ['planning', 'paused'],
    ['planning', 'done'],
    ['paused', 'done'],
    ['done', 'running'],
    ['done', 'failed'],
    ['failed', 'running'],
    ['running', 'planning'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(canJobTransition(from, to)).toBe(false);
    expect(() => assertJobTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('terminal states have no exits', () => {
    for (const to of ['planning', 'running', 'paused', 'done', 'failed'] as const) {
      expect(canJobTransition('done', to)).toBe(false);
      expect(canJobTransition('failed', to)).toBe(false);
    }
  });
});

describe('section statechart (F10)', () => {
  it.each([
    ['pending', 'writing'],
    ['writing', 'revising'],
    ['writing', 'done'],
    ['writing', 'degraded'],
    ['revising', 'writing'],
    ['revising', 'done'],
    ['revising', 'degraded'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(canSectionTransition(from, to)).toBe(true);
  });

  it.each([
    ['pending', 'done'],
    ['pending', 'degraded'],
    ['done', 'writing'],
    ['degraded', 'writing'],
    ['done', 'pending'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(() => assertSectionTransition(from, to)).toThrow(InvalidTransitionError);
  });
});

describe('job retention & resume cap', () => {
  it('expiresAt honours AEGIS_JOB_TTL_HOURS with a 7-day default', () => {
    const now = new Date('2026-07-17T12:00:00Z');
    expect(jobExpiresAt(now).getTime() - now.getTime()).toBe(7 * 24 * 3_600_000);
  });

  it('resume cap defaults to 12 (F4)', () => {
    expect(jobMaxResumes()).toBe(12);
  });
});

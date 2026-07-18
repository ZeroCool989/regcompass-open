import { intEnv } from '../env';

/**
 * Job / section state machines (epic F10) — pure TS, no I/O. Every persisted
 * status transition MUST go through `assertJobTransition` /
 * `assertSectionTransition`; an invalid transition throws instead of silently
 * corrupting a job. The store (job-store.ts) additionally guards each write
 * with a status-scoped `updateMany` so a concurrent transition loses cleanly.
 *
 *   Job:     planning → running → (paused ↔ running) → done | failed
 *   Section: pending → writing → (revising → writing)* → done | degraded
 *
 * `failed` is reachable from every non-terminal job state (resume cap, expiry,
 * unrecoverable upstream error). Terminal states have no exits.
 */

export type JobStatus = 'planning' | 'running' | 'paused' | 'done' | 'failed';
export type SectionStatus = 'pending' | 'writing' | 'revising' | 'done' | 'degraded';

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  planning: ['running', 'failed'],
  running: ['paused', 'done', 'failed'],
  paused: ['running', 'failed'],
  done: [],
  failed: [],
};

const SECTION_TRANSITIONS: Record<SectionStatus, readonly SectionStatus[]> = {
  pending: ['writing'],
  writing: ['revising', 'done', 'degraded'],
  revising: ['writing', 'done', 'degraded'],
  done: [],
  degraded: [],
};

export class InvalidTransitionError extends Error {
  constructor(kind: 'job' | 'section', from: string, to: string) {
    super(`Invalid ${kind} transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canJobTransition(from, to)) throw new InvalidTransitionError('job', from, to);
}

export function canSectionTransition(from: SectionStatus, to: SectionStatus): boolean {
  return SECTION_TRANSITIONS[from].includes(to);
}

export function assertSectionTransition(from: SectionStatus, to: SectionStatus): void {
  if (!canSectionTransition(from, to)) {
    throw new InvalidTransitionError('section', from, to);
  }
}

/** Job retention (F10: `expiresAt` for the retention cron). Default 7 days. */
export function jobExpiresAt(now: Date = new Date()): Date {
  const ttlHours = intEnv('AEGIS_JOB_TTL_HOURS', 7 * 24);
  return new Date(now.getTime() + ttlHours * 3_600_000);
}

/** Hard cap on resume invocations per job (F4). */
export const jobMaxResumes = (): number => intEnv('AEGIS_JOB_MAX_RESUMES', 12);

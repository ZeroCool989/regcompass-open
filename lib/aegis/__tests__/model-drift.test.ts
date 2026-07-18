import { describe, expect, it } from 'vitest';
import { isModelDrift, modelFamily } from '../types';

describe('modelFamily', () => {
  it('extracts the tier, ignoring version/snapshot suffix', () => {
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelFamily('claude-sonnet-4-6-20260207')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('claude-opus-4-7')).toBe('opus');
  });

  it('returns null for an unrecognised id', () => {
    expect(modelFamily('gpt-4o')).toBeNull();
    expect(modelFamily('claude-unknown-9')).toBeNull();
  });
});

describe('isModelDrift', () => {
  it('a dated snapshot of the same tier is NOT drift', () => {
    expect(isModelDrift('claude-sonnet-4-6', 'claude-sonnet-4-6-20260207')).toBe(false);
  });

  it('a tier swap IS drift', () => {
    expect(isModelDrift('claude-sonnet-4-6', 'claude-haiku-4-5')).toBe(true);
    expect(isModelDrift('claude-opus-4-7', 'claude-sonnet-4-6')).toBe(true);
  });

  it('does not assert drift when either family is unparseable (no false positives)', () => {
    expect(isModelDrift('claude-sonnet-4-6', 'mystery-model')).toBe(false);
    expect(isModelDrift('mystery-model', 'claude-haiku-4-5')).toBe(false);
  });
});

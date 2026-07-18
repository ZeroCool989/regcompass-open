import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHeartbeat } from '../heartbeat';
import { intEnv } from '../env';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createHeartbeat', () => {
  it('ticks on the interval while running', () => {
    vi.useFakeTimers();
    let ticks = 0;
    createHeartbeat(() => { ticks += 1; }, 1000);
    vi.advanceTimersByTime(3500);
    expect(ticks).toBe(3);
  });

  it('stops immediately and never ticks after stop()', () => {
    vi.useFakeTimers();
    let ticks = 0;
    const hb = createHeartbeat(() => { ticks += 1; }, 1000);
    vi.advanceTimersByTime(2000);
    expect(ticks).toBe(2);
    hb.stop();
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(2); // no further ticks
  });

  it('stop() is idempotent', () => {
    vi.useFakeTimers();
    const hb = createHeartbeat(() => {}, 1000);
    expect(() => { hb.stop(); hb.stop(); }).not.toThrow();
  });
});

describe('intEnv', () => {
  it('returns the fallback when unset', () => {
    expect(intEnv('AEGIS_TEST_UNSET_XYZ', 42)).toBe(42);
  });
  it('reads a positive integer override', () => {
    vi.stubEnv('AEGIS_TEST_SET_XYZ', '8192');
    expect(intEnv('AEGIS_TEST_SET_XYZ', 42)).toBe(8192);
  });
  it('falls back on invalid / non-positive values', () => {
    vi.stubEnv('AEGIS_TEST_BAD_XYZ', 'nope');
    expect(intEnv('AEGIS_TEST_BAD_XYZ', 42)).toBe(42);
    vi.stubEnv('AEGIS_TEST_NEG_XYZ', '-5');
    expect(intEnv('AEGIS_TEST_NEG_XYZ', 42)).toBe(42);
  });
});

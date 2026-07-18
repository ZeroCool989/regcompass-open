import { describe, it, expect, vi } from 'vitest';
import { isRetryableConnectionError, withDbRetry } from '../db';

describe('isRetryableConnectionError', () => {
  it('is true for connection-establishment failures', () => {
    expect(isRetryableConnectionError({ code: 'P1001' })).toBe(true);
    expect(isRetryableConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableConnectionError(new Error("Can't reach database server at ep-xyz.neon.tech"))).toBe(true);
  });

  it('is false for non-connection errors (never double-runs a real query failure)', () => {
    expect(isRetryableConnectionError({ code: 'P2002' })).toBe(false); // unique constraint
    expect(isRetryableConnectionError(new Error('row not found'))).toBe(false);
    expect(isRetryableConnectionError(null)).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('returns the result on first success (no retry)', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withDbRetry(op, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a cold-start (P1001) then succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce({ code: 'P1001' })
      .mockRejectedValueOnce({ code: 'P1001' })
      .mockResolvedValue('awake');
    await expect(withDbRetry(op, { baseDelayMs: 0, maxRetries: 3 })).resolves.toBe('awake');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-connection error', async () => {
    const op = vi.fn().mockRejectedValue({ code: 'P2002' });
    await expect(withDbRetry(op, { baseDelayMs: 0 })).rejects.toMatchObject({ code: 'P2002' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const op = vi.fn().mockRejectedValue({ code: 'P1001' });
    await expect(withDbRetry(op, { baseDelayMs: 0, maxRetries: 2 })).rejects.toMatchObject({ code: 'P1001' });
    expect(op).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

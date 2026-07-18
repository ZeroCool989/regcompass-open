import { describe, expect, it } from 'vitest';
import {
  createResetToken,
  hashPassword,
  peekResetTokenEmail,
  verifyResetToken,
} from '@/lib/auth';

const EMAIL = 'user@allow.test';

describe('password-reset token (hash-bound, option B)', () => {
  it('verifies against the same password hash', () => {
    const hash = hashPassword('old-password');
    const token = createResetToken(EMAIL, hash);
    expect(verifyResetToken(token, hash)).toBe(EMAIL);
  });

  it('is rejected once the password hash changes (invalidate-on-reset)', () => {
    const oldHash = hashPassword('old-password');
    const token = createResetToken(EMAIL, oldHash);
    const newHash = hashPassword('new-password'); // simulates a completed reset
    // The account now has newHash → the old link no longer verifies.
    expect(verifyResetToken(token, newHash)).toBeNull();
    // Sanity: the binding is specifically to the hash it was minted against.
    expect(verifyResetToken(token, oldHash)).toBe(EMAIL);
  });

  it('rejects an expired token', () => {
    const hash = hashPassword('pw');
    const token = createResetToken(EMAIL, hash, -1000); // already expired
    expect(verifyResetToken(token, hash)).toBeNull();
  });

  it('rejects a tampered MAC', () => {
    const hash = hashPassword('pw');
    const token = createResetToken(EMAIL, hash);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyResetToken(tampered, hash)).toBeNull();
  });

  it('rejects a forged email swapped into the payload', () => {
    const hash = hashPassword('pw');
    const token = createResetToken(EMAIL, hash);
    const mac = token.slice(token.lastIndexOf('.') + 1);
    const forgedPayload = Buffer.from(`attacker@evil.test|${Date.now() + 10_000}`).toString('base64url');
    expect(verifyResetToken(`${forgedPayload}.${mac}`, hash)).toBeNull();
  });

  it('peekResetTokenEmail returns the (unverified) email, null on garbage', () => {
    const token = createResetToken(EMAIL, hashPassword('pw'));
    expect(peekResetTokenEmail(token)).toBe(EMAIL);
    expect(peekResetTokenEmail('garbage')).toBeNull();
    expect(peekResetTokenEmail(null)).toBeNull();
  });
});

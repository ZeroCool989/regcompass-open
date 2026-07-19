import { describe, expect, it } from 'vitest';
import {
  authCookieValue,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  isAdminEmail,
  isAllowlisted,
  requireAdmin,
  verifyAuthValue,
  verifyPassword,
} from '@/lib/auth';

describe('password hashing (scrypt)', () => {
  it('verifies the correct password and rejects the wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('uses a random salt so equal passwords hash differently', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects malformed stored values', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$a$b')).toBe(false);
  });
});

describe('auth cookie signing', () => {
  it('round-trips a valid signed user id', () => {
    const value = authCookieValue('user-123');
    expect(verifyAuthValue(value)).toBe('user-123');
  });

  it('rejects a tampered id and a missing signature', () => {
    const value = authCookieValue('user-123');
    const tampered = 'user-999.' + value.slice(value.lastIndexOf('.') + 1);
    expect(verifyAuthValue(tampered)).toBeNull();
    expect(verifyAuthValue('user-123')).toBeNull();
    expect(verifyAuthValue(null)).toBeNull();
  });
});

describe('admin allowlist', () => {
  it('matches case-insensitively against ADMIN_EMAILS', () => {
    process.env.ADMIN_EMAILS = 'Boss@Example.com, other@x.io';
    expect(isAdminEmail('boss@example.com')).toBe(true);
    expect(isAdminEmail('BOSS@EXAMPLE.COM')).toBe(true);
    expect(isAdminEmail('nope@example.com')).toBe(false);
  });
});

describe('requireAdmin — role AND status (SEC-2)', () => {
  const base = { email: 'a@x.io', role: 'ADMIN', status: 'APPROVED' } as const;

  it('grants only approved admins', () => {
    process.env.ADMIN_EMAILS = '';
    expect(requireAdmin({ ...base })).toBe(true);
  });

  it('blocked or pending admins lose admin powers immediately', () => {
    process.env.ADMIN_EMAILS = '';
    expect(requireAdmin({ ...base, status: 'BLOCKED' })).toBe(false);
    expect(requireAdmin({ ...base, status: 'PENDING' })).toBe(false);
  });

  it('approved non-admins and anonymous callers are rejected', () => {
    process.env.ADMIN_EMAILS = '';
    expect(requireAdmin({ ...base, role: 'USER' })).toBe(false);
    expect(requireAdmin(null)).toBe(false);
  });

  it('allowlisted email counts as admin role — but never overrides status', () => {
    process.env.ADMIN_EMAILS = 'a@x.io';
    expect(requireAdmin({ ...base, role: 'USER' })).toBe(true);
    expect(requireAdmin({ ...base, role: 'USER', status: 'BLOCKED' })).toBe(false);
  });
});

describe('login allowlist (AUTH_ALLOWLIST)', () => {
  it('matches case-insensitively and trims, rejecting non-listed emails', () => {
    process.env.AUTH_ALLOWLIST = 'A@Example.com, b@x.io';
    expect(isAllowlisted('a@example.com')).toBe(true);
    expect(isAllowlisted('A@EXAMPLE.COM')).toBe(true);
    expect(isAllowlisted('  b@x.io  ')).toBe(true);
    expect(isAllowlisted('nope@example.com')).toBe(false);
  });

  it('rejects everyone when the env is unset or blank (fail closed)', () => {
    delete process.env.AUTH_ALLOWLIST;
    expect(isAllowlisted('a@example.com')).toBe(false);
    process.env.AUTH_ALLOWLIST = '   ';
    expect(isAllowlisted('a@example.com')).toBe(false);
  });
});

describe('dummy password hash (timing defense)', () => {
  it('is a valid scrypt$ hash that no password verifies against', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  isUpdateAvailable,
  buildUpdateStatus,
  summarizeManifest,
  kbUpdateBaseUrl,
  DEFAULT_KB_UPDATE_URL,
  type KbVersionInfo,
} from '@/lib/kb/version';
import type { KbManifest } from '@/lib/kb/types';

const local: KbVersionInfo = { kbVersion: 'aaaa', generatedAt: '2026-01-01', requirements: 265 };

describe('isUpdateAvailable', () => {
  it('no remote → no update', () => {
    expect(isUpdateAvailable(local, null)).toBe(false);
  });

  it('same version → no update even if dates differ', () => {
    expect(isUpdateAvailable(local, { ...local, generatedAt: '2026-05-01' })).toBe(false);
  });

  it('different version, newer date → update available', () => {
    expect(isUpdateAvailable(local, { kbVersion: 'bbbb', generatedAt: '2026-02-01', requirements: 270 })).toBe(true);
  });

  it('different version, same date → update available (same-day re-cut)', () => {
    expect(isUpdateAvailable(local, { kbVersion: 'bbbb', generatedAt: '2026-01-01', requirements: 266 })).toBe(true);
  });

  it('different version but OLDER date → no downgrade offered', () => {
    expect(isUpdateAvailable(local, { kbVersion: 'bbbb', generatedAt: '2025-12-01', requirements: 200 })).toBe(false);
  });
});

describe('buildUpdateStatus', () => {
  it('wraps local/remote and the computed flag', () => {
    const remote = { kbVersion: 'bbbb', generatedAt: '2026-03-01', requirements: 280 };
    expect(buildUpdateStatus(local, remote)).toEqual({ local, remote, updateAvailable: true });
    expect(buildUpdateStatus(local, null)).toEqual({ local, remote: null, updateAvailable: false });
  });
});

describe('summarizeManifest', () => {
  it('projects a full manifest down to the version fields', () => {
    const m = {
      kbVersion: 'deadbeef',
      generatedAt: '2026-07-17',
      totals: { requirements: 265, controls: 160, regulations: 19, crosswalk: 15 },
      verification: { manuallyVerified: 264, coveragePct: 99.6, byMethod: {} },
      sourceChecksums: { manifest: 'x', present: true, sha256: 'y' },
    } as unknown as KbManifest;
    expect(summarizeManifest(m)).toEqual({ kbVersion: 'deadbeef', generatedAt: '2026-07-17', requirements: 265 });
  });
});

describe('kbUpdateBaseUrl', () => {
  it('defaults to the public repo', () => {
    expect(kbUpdateBaseUrl({})).toBe(DEFAULT_KB_UPDATE_URL);
    expect(kbUpdateBaseUrl({ KB_UPDATE_URL: '  ' })).toBe(DEFAULT_KB_UPDATE_URL);
  });

  it('honours an override and strips trailing slashes', () => {
    expect(kbUpdateBaseUrl({ KB_UPDATE_URL: 'https://mirror.example/kb/' })).toBe('https://mirror.example/kb');
  });
});

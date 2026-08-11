/**
 * Knowledge-base version comparison — shared by the update script
 * (`scripts/update-kb.ts`), the `/api/kb/version` route, and the in-app
 * "update available" banner. Pure + dependency-light (no fs, no network) so it
 * runs on client and server and is straightforward to unit-test.
 *
 * The KB version is the content hash (`kbVersion`) recorded in
 * `lib/kb/manifest.json`; `generatedAt` (YYYY-MM-DD) orders releases in time.
 * An update is only offered when the remote is a *different* build that is not
 * older than the local one — so a stale mirror never triggers a downgrade.
 */

import type { KbManifest } from './types';

/** The subset of a KB manifest the UI and the comparison actually need. */
export interface KbVersionInfo {
  kbVersion: string;
  generatedAt: string;
  requirements: number;
}

export interface KbUpdateStatus {
  local: KbVersionInfo;
  /** null when the remote manifest could not be fetched/parsed. */
  remote: KbVersionInfo | null;
  updateAvailable: boolean;
}

/** Project a full manifest down to the fields the version UI displays. */
export function summarizeManifest(m: KbManifest): KbVersionInfo {
  return {
    kbVersion: m.kbVersion,
    generatedAt: m.generatedAt,
    requirements: m.totals.requirements,
  };
}

/**
 * Whether `remote` should be offered as an update over `local`. True only when
 * the content differs AND the remote build is not dated before the local one
 * (equal dates with a different hash still count — a same-day re-cut).
 */
export function isUpdateAvailable(
  local: KbVersionInfo,
  remote: KbVersionInfo | null,
): boolean {
  if (!remote) return false;
  if (remote.kbVersion === local.kbVersion) return false;
  return remote.generatedAt >= local.generatedAt;
}

export function buildUpdateStatus(
  local: KbVersionInfo,
  remote: KbVersionInfo | null,
): KbUpdateStatus {
  return { local, remote, updateAvailable: isUpdateAvailable(local, remote) };
}

/**
 * Default base URL the update tooling fetches the canonical KB from — the
 * public repo's `main`. Overridable via `KB_UPDATE_URL` so a fork or an
 * internal mirror can serve the KB instead. No user data is ever sent; these
 * are plain GETs of public JSON files.
 */
export const DEFAULT_KB_UPDATE_URL =
  'https://raw.githubusercontent.com/ZeroCool989/regcompass-open/main/lib/kb';

export function kbUpdateBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const v = env.KB_UPDATE_URL?.trim();
  return v && v.length > 0 ? v.replace(/\/+$/, '') : DEFAULT_KB_UPDATE_URL;
}

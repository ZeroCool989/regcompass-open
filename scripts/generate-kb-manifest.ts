/**
 * Generates lib/kb/manifest.json — the audit-metadata snapshot every
 * generated assessment cites (KB version, verification coverage, checksum
 * status). Regenerate whenever KB data changes:
 *   npm run kb:manifest
 * CI (scripts/validate-kb.ts) fails when the manifest is stale.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Generate the manifest for a custom KB when KB_DIR is set, else the bundled one.
const KB_DIR = process.env.KB_DIR?.trim() || null;
const KB_ROOT = KB_DIR ? resolve(KB_DIR) : join(root, 'lib/kb');
const SOURCE_DIR = KB_DIR ? join(resolve(KB_DIR), 'source') : join(root, 'docs/source');

export function computeKbVersion(): string {
  const hash = createHash('sha256');
  for (const f of ['requirements.json', 'regulations.json', 'crosswalk.json']) {
    hash.update(readFileSync(join(KB_ROOT, f)));
  }
  return hash.digest('hex').slice(0, 16);
}

function main() {
  const reqs: Array<Record<string, unknown>> = JSON.parse(
    readFileSync(join(KB_ROOT, 'requirements.json'), 'utf8'),
  );
  const regs: unknown[] = JSON.parse(readFileSync(join(KB_ROOT, 'regulations.json'), 'utf8'));
  const crosswalk: unknown[] = JSON.parse(readFileSync(join(KB_ROOT, 'crosswalk.json'), 'utf8'));

  const manifestPath = join(SOURCE_DIR, 'CHECKSUMS.sha256');
  const byMethod: Record<string, number> = {};
  for (const r of reqs) {
    const m = (r.verificationMethod as string) ?? 'unknown';
    byMethod[m] = (byMethod[m] ?? 0) + 1;
  }
  const verifiedCount = reqs.filter(r => r.verified === true).length;

  const manifest = {
    kbVersion: computeKbVersion(),
    generatedAt: new Date().toISOString().slice(0, 10),
    totals: {
      requirements: reqs.length,
      controls: reqs.reduce((n, r) => n + ((r.controls as unknown[])?.length ?? 0), 0),
      regulations: regs.length,
      crosswalk: crosswalk.length,
    },
    verification: {
      manuallyVerified: verifiedCount,
      coveragePct: Math.round((verifiedCount / reqs.length) * 1000) / 10,
      byMethod,
    },
    sourceChecksums: {
      manifest: 'source/CHECKSUMS.sha256',
      present: existsSync(manifestPath),
      sha256: existsSync(manifestPath)
        ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex').slice(0, 16)
        : null,
    },
  };

  writeFileSync(join(KB_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
}

main();

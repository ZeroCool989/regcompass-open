/**
 * KB integrity gate — run in CI and before any KB change is merged.
 * Run: npx tsx scripts/validate-kb.ts
 *
 * Fails (exit 1) on:
 *  1. Schema violations (Zod parse of requirements/regulations/crosswalk,
 *     incl. canonical riskTier enum — synonyms like 'high'/'unacceptable'
 *     are rejected by the schema, see ADR-001).
 *  2. Duplicate requirement/regulation/crosswalk IDs; duplicate control IDs
 *     within an entry; cross-entry control-ID reuse with divergent content.
 *  3. Broken references: crosswalk → requirement IDs, crosswalk → standard
 *     IDs, requirement.regulation → regulations.json.
 *  4. Provenance: missing/invalid/non-resolving sourceFile (except
 *     documented waivers), sourceFile not covered by CHECKSUMS.sha256.
 *  5. Checksum mismatches between docs/source/ files and CHECKSUMS.sha256,
 *     and manifest/directory drift in either direction.
 *  6. Article references that cannot be located in the primary source
 *     (hallucinated-reference detection; designator-style refs are skipped
 *     and reported).
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { Requirement, RegulationMeta, CrosswalkEntry } from '../lib/kb/types';
import { checkArticleRefs, controlFingerprint } from '../lib/kb/validate-helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Validate a custom KB when KB_DIR is set, otherwise the bundled one.
const KB_DIR = process.env.KB_DIR?.trim() || null;
const KB_ROOT = KB_DIR ? resolve(KB_DIR) : join(root, 'lib/kb');
const SOURCE_DIR = KB_DIR ? join(resolve(KB_DIR), 'source') : join(root, 'docs/source');
const MANIFEST = join(SOURCE_DIR, 'CHECKSUMS.sha256');

/**
 * Entries allowed to lack a primary source file. Every waiver needs a
 * rationale and should be temporary — see docs/governance/MIGRATION_NOTES.md.
 */
const PROVENANCE_WAIVERS: Record<string, string> = {
  ISO_23894: 'No primary source text available in docs/source/; single entry, still on automated-crosscheck-v1 (VERIFICATION_REPORT.md, Outstanding Work #1).',
};

const errors: string[] = [];
const warnings: string[] = [];
const err = (s: string) => errors.push(s);
const warn = (s: string) => warnings.push(s);

// KB JSON files are resolved against KB_ROOT (KB_DIR when set, else lib/kb),
// so the same validator runs over a bundled or a bring-your-own KB.
function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(KB_ROOT, basename(rel)), 'utf8'));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) (seen.has(id) ? dups : seen).add(id);
  return [...dups];
}

// ---------------------------------------------------------------- 1. schema
const reqParse = z.array(Requirement).safeParse(loadJson('lib/kb/requirements.json'));
const regParse = z.array(RegulationMeta).safeParse(loadJson('lib/kb/regulations.json'));
const cwParse = z.array(CrosswalkEntry).safeParse(loadJson('lib/kb/crosswalk.json'));
for (const [name, parse] of [
  ['requirements.json', reqParse], ['regulations.json', regParse], ['crosswalk.json', cwParse],
] as const) {
  if (!parse.success) {
    for (const issue of parse.error.issues.slice(0, 20)) {
      err(`schema ${name} at ${issue.path.join('.')}: ${issue.message}`);
    }
  }
}

if (reqParse.success && regParse.success && cwParse.success) {
  const reqs = reqParse.data;
  const regs = regParse.data;
  const crosswalk = cwParse.data;

  // ---------------------------------------------------------- 2. duplicates
  for (const d of findDuplicates(reqs.map(r => r.id))) err(`duplicate requirement id: ${d}`);
  for (const d of findDuplicates(regs.map(r => r.id))) err(`duplicate regulation id: ${d}`);
  for (const d of findDuplicates(crosswalk.map(c => c.id))) err(`duplicate crosswalk id: ${d}`);
  const controlVariants = new Map<string, Set<string>>();
  for (const r of reqs) {
    for (const d of findDuplicates(r.controls.map(c => c.id))) {
      err(`duplicate control id within ${r.id}: ${d}`);
    }
    for (const c of r.controls) {
      if (!controlVariants.has(c.id)) controlVariants.set(c.id, new Set());
      controlVariants.get(c.id)!.add(controlFingerprint(c));
    }
  }
  for (const [id, variants] of controlVariants) {
    if (variants.size > 1) err(`control id ${id} maps to ${variants.size} divergent control definitions across entries`);
  }

  // ------------------------------------------------- 3. referential integrity
  const reqIds = new Set(reqs.map(r => r.id));
  const regIds = new Set(regs.map(r => r.id));
  for (const r of reqs) {
    if (!regIds.has(r.regulation)) err(`${r.id}: regulation ${r.regulation} missing from regulations.json`);
  }
  for (const c of crosswalk) {
    for (const rid of c.requirements) {
      if (!reqIds.has(rid)) err(`crosswalk ${c.id}: dangling requirement reference ${rid}`);
    }
    for (const std of c.standards) {
      const prefix = std.split(':')[0];
      if (!regIds.has(prefix)) err(`crosswalk ${c.id}: standard reference "${std}" has unknown standard id ${prefix}`);
    }
  }

  // ----------------------------------------------- 4.+5. provenance/checksums
  const manifest = new Map<string, string>();
  if (!existsSync(MANIFEST)) {
    err('docs/source/CHECKSUMS.sha256 missing — regenerate with scripts (shasum -a 256 *.txt > CHECKSUMS.sha256)');
  } else {
    for (const line of readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean)) {
      const m = line.match(/^([0-9a-f]{64})\s+[* ]?(.+)$/);
      if (!m) { err(`CHECKSUMS.sha256: unparseable line: ${line}`); continue; }
      manifest.set(m[2], m[1]);
    }
    for (const [file, expected] of manifest) {
      const path = join(SOURCE_DIR, file);
      if (!existsSync(path)) { err(`CHECKSUMS.sha256 lists missing file: ${file}`); continue; }
      const actual = sha256(path);
      if (actual !== expected) {
        err(`checksum mismatch for docs/source/${file}: manifest ${expected.slice(0, 12)}…, actual ${actual.slice(0, 12)}… — source text changed without provenance update`);
      }
    }
    for (const file of readdirSync(SOURCE_DIR).filter(f => f.endsWith('.txt'))) {
      if (!manifest.has(file)) err(`docs/source/${file} not covered by CHECKSUMS.sha256`);
    }
  }

  const sourceTextCache = new Map<string, string>();
  const sourceText = (file: string): string => {
    if (!sourceTextCache.has(file)) sourceTextCache.set(file, readFileSync(join(SOURCE_DIR, file), 'utf8'));
    return sourceTextCache.get(file)!;
  };

  for (const r of reqs) {
    if (!r.sourceFile) {
      if (PROVENANCE_WAIVERS[r.regulation]) {
        warn(`${r.id}: no sourceFile — waived (${r.regulation}): ${PROVENANCE_WAIVERS[r.regulation]}`);
      } else {
        err(`${r.id}: sourceFile missing and no provenance waiver for ${r.regulation}`);
      }
      continue;
    }
    if (r.sourceFile !== basename(r.sourceFile)) {
      err(`${r.id}: sourceFile must be a plain filename inside the source/ folder, got "${r.sourceFile}"`);
      continue;
    }
    if (!existsSync(join(SOURCE_DIR, r.sourceFile))) {
      err(`${r.id}: sourceFile does not resolve under ${SOURCE_DIR}: ${r.sourceFile}`);
      continue;
    }
    if (manifest.size > 0 && !manifest.has(r.sourceFile)) {
      err(`${r.id}: sourceFile ${r.sourceFile} not covered by CHECKSUMS.sha256`);
    }

    // ------------------------------------------------- 6. article validation
    const check = checkArticleRefs(r.article, sourceText(r.sourceFile));
    for (const missing of check.missing) {
      err(`${r.id}: article reference "${missing.label}" (from "${r.article}") not located in docs/source/${r.sourceFile} — possible hallucinated reference`);
    }
    for (const skipped of check.skipped) {
      warn(`${r.id}: designator-style reference "${skipped.label}" identifies a document, not a location — skipped`);
    }
    if (check.located.length === 0 && check.missing.length === 0 && check.skipped.length === 0) {
      warn(`${r.id}: article field "${r.article}" produced no checkable references`);
    }
  }
}

// ------------------------------------------------- 7. manifest freshness
{
  const manifestFile = join(KB_ROOT, 'manifest.json');
  if (!existsSync(manifestFile)) {
    err('manifest.json missing — run `npm run kb:manifest`');
  } else {
    const kbHash = createHash('sha256');
    for (const f of ['requirements.json', 'regulations.json', 'crosswalk.json']) {
      kbHash.update(readFileSync(join(KB_ROOT, f)));
    }
    const expected = kbHash.digest('hex').slice(0, 16);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (manifest.kbVersion !== expected) {
      err(`manifest.json is stale (kbVersion ${manifest.kbVersion}, data hash ${expected}) — run \`npm run kb:manifest\``);
    }
  }
}

// ------------------------------------------------------------------- report
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`\nvalidate-kb: ${errors.length} error(s), ${warnings.length} warning(s)`);
if (errors.length > 0) process.exit(1);
console.log('validate-kb: PASS');

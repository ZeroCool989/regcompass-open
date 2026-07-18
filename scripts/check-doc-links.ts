/**
 * Markdown link checker — CI gate against dead documentation references.
 * Run: npx tsx scripts/check-doc-links.ts
 *
 * Checks every relative `[text](target)` link in tracked markdown files and
 * fails when the target does not exist on disk. External links (http/https/
 * mailto) and pure in-page anchors are ignored. `docs/archive/` is excluded:
 * archived documents describe historical states and are not maintained.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED = ['node_modules', '.git', '.next', 'docs/archive'];

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path).split(sep).join('/');
    if (EXCLUDED.some(e => rel === e || rel.startsWith(e + '/'))) continue;
    if (statSync(path).isDirectory()) out.push(...mdFiles(path));
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const broken: string[] = [];
let checked = 0;

for (const file of mdFiles(root)) {
  const text = readFileSync(file, 'utf8');
  // [text](target) — tolerate an optional "title" after the target.
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    const path = resolve(dirname(file), decodeURI(target.split('#')[0]));
    checked++;
    if (!existsSync(path)) {
      const line = text.slice(0, m.index).split('\n').length;
      broken.push(`${relative(root, file)}:${line} → ${target}`);
    }
  }
}

for (const b of broken) console.error(`BROKEN ${b}`);
console.log(`check-doc-links: ${checked} relative link(s) checked, ${broken.length} broken`);
if (broken.length > 0) process.exit(1);
console.log('check-doc-links: PASS');

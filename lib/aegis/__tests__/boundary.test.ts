import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_DIR = join(process.cwd(), 'lib', 'aegis', 'tools');

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'fetch(', pattern: /\bfetch\s*\(/ },
  { name: "from 'fs'", pattern: /from\s+['"]fs['"]/ },
  { name: "from 'node:fs'", pattern: /from\s+['"]node:fs['"]/ },
  { name: "from 'child_process'", pattern: /from\s+['"]child_process['"]/ },
  { name: "from 'node:child_process'", pattern: /from\s+['"]node:child_process['"]/ },
  { name: "require('fs')", pattern: /require\s*\(\s*['"]fs['"]\s*\)/ },
  { name: "require('child_process')", pattern: /require\s*\(\s*['"]child_process['"]\s*\)/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
];

// read_source is the single documented exception to the no-fs rule: it
// reads only files under docs/source/ to surface raw legislation passages
// when the curated KB has gaps. Path containment is enforced inside the
// tool. Network and child_process patterns are still forbidden everywhere.
const FS_EXCEPTION_FILES = new Set(['read_source.ts']);
const FS_PATTERN_NAMES = new Set([
  "from 'fs'",
  "from 'node:fs'",
  "require('fs')",
]);

describe('Tools boundary — lib/aegis/tools/*.ts must not reach the network or filesystem', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));

  it('discovers at least 6 tool files', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of files) {
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    const isFsException = FS_EXCEPTION_FILES.has(file);
    for (const { name, pattern } of FORBIDDEN) {
      if (isFsException && FS_PATTERN_NAMES.has(name)) {
        // Documented fs exception (read_source.ts only). Network and
        // child_process patterns below still apply.
        continue;
      }
      it(`${file}: contains no ${name}`, () => {
        expect(src).not.toMatch(pattern);
      });
    }
  }

  it('read_source.ts is the only file allowed to import fs', () => {
    let fsImporters = 0;
    for (const file of files) {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      if (/from\s+['"]node:fs['"]/.test(src) || /from\s+['"]fs['"]/.test(src)) {
        fsImporters++;
        expect(FS_EXCEPTION_FILES.has(file)).toBe(true);
      }
    }
    // Make the exception visible: exactly one file is allowed to import fs.
    expect(fsImporters).toBe(1);
  });
});

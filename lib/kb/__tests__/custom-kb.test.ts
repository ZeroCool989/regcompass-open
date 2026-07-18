import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Verifies that a bring-your-own knowledge base (KB_DIR) is loaded in place of
 * the bundled one: custom regulations/categories are accepted, accessors work,
 * and read_source resolves source files from the custom KB while still blocking
 * regulations the KB does not map.
 *
 * lib/kb reads KB_DIR at module load, so each case stubs the env and
 * re-imports the module in isolation.
 */

function makeRequirement(over: Record<string, unknown>) {
  return {
    id: 'X-1',
    title: 'Custom requirement',
    regulation: 'MY_REG',
    article: 'Art. 1',
    jurisdiction: ['EU'],
    summary: 'A custom summary about widgets and controls.',
    body: 'The custom body text.',
    tags: ['widget'],
    audience: ['all'],
    category: 'my-custom-category',
    relevanceForFinancialSector: 'high',
    bindingLevel: 'mandatory',
    enforcementConsequence: 'Fines.',
    controls: [],
    ...over,
  };
}

function writeKb(dir: string) {
  mkdirSync(join(dir, 'source'), { recursive: true });
  const reqs = [
    makeRequirement({ id: 'X-1', regulation: 'MY_REG', sourceFile: 'my_reg.txt' }),
    makeRequirement({ id: 'X-2', regulation: 'MY_REG', title: 'Second', summary: 'widget governance' }),
    makeRequirement({ id: 'X-3', regulation: 'OTHER_REG', sourceFile: undefined }),
  ];
  writeFileSync(join(dir, 'requirements.json'), JSON.stringify(reqs));
  writeFileSync(
    join(dir, 'regulations.json'),
    JSON.stringify([
      { id: 'MY_REG', name: 'My Regulation', shortName: 'MyReg', jurisdiction: 'EU', description: 'x', bindingLevel: 'mandatory', enforcementConsequence: 'Fines.' },
      { id: 'OTHER_REG', name: 'Other', shortName: 'Other', jurisdiction: 'EU', description: 'y', bindingLevel: 'best_practice', enforcementConsequence: 'None.' },
    ]),
  );
  writeFileSync(join(dir, 'crosswalk.json'), JSON.stringify([]));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      kbVersion: 'test',
      generatedAt: '2026-01-01',
      totals: { requirements: 3, controls: 0, regulations: 2, crosswalk: 0 },
      verification: { manuallyVerified: 0, coveragePct: 0, byMethod: {} },
      sourceChecksums: { manifest: 'source/CHECKSUMS.sha256', present: false, sha256: null },
    }),
  );
  writeFileSync(join(dir, 'source', 'my_reg.txt'), 'Artikel 1 — widget governance rules and obligations.\n');
}

const tmpDirs: string[] = [];
function freshKbDir() {
  const d = mkdtempSync(join(tmpdir(), 'rc-kb-'));
  tmpDirs.push(d);
  writeKb(d);
  return d;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('custom KB_DIR', () => {
  it('loads requirements from KB_DIR with custom regulation and category', async () => {
    const dir = freshKbDir();
    vi.stubEnv('KB_DIR', dir);
    vi.resetModules();
    const { KB } = await import('../index');

    expect(KB.requirements).toHaveLength(3);
    expect(KB.byId('X-1')?.regulation).toBe('MY_REG');
    expect(KB.byCategory('my-custom-category').map((r) => r.id)).toContain('X-1');
    expect(KB.search('widget').length).toBeGreaterThan(0);
  });

  it('derives the source-file map from the custom KB', async () => {
    const dir = freshKbDir();
    vi.stubEnv('KB_DIR', dir);
    vi.resetModules();
    const { KB } = await import('../index');

    expect(KB.sourceFileFor('MY_REG')).toBe('my_reg.txt');
    expect(KB.regulationsWithSource).toEqual(['MY_REG']);
    // OTHER_REG has no sourceFile in the custom KB.
    expect(KB.sourceFileFor('OTHER_REG')).toBeUndefined();
  });

  it('read_source resolves a custom source file and blocks unmapped regulations', async () => {
    const dir = freshKbDir();
    vi.stubEnv('KB_DIR', dir);
    vi.resetModules();
    const { executeReadSource } = await import('../../aegis/tools/read_source');

    const passages = executeReadSource({ regulation: 'MY_REG', query: 'widget' });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].file).toBe('my_reg.txt');

    // A regulation not mapped to a source file is rejected before any fs access.
    expect(() => executeReadSource({ regulation: 'OTHER_REG', query: 'x' })).toThrow(/source_access_denied/);
    expect(() => executeReadSource({ regulation: '../../etc/passwd', query: 'x' })).toThrow(/source_access_denied/);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test isolation for the local credential store.
 *
 * The OAuth token store (lib/aegis/oauth/store.ts) lives under REGCOMPASS_OPEN_DIR,
 * defaulting to ~/.regcompass-open. Point that at a throwaway temp dir for the whole
 * suite so a developer's real, machine-local credentials can never leak into a test.
 */
if (!process.env.REGCOMPASS_OPEN_DIR) {
  process.env.REGCOMPASS_OPEN_DIR = mkdtempSync(join(tmpdir(), 'regcompass-test-'));
}

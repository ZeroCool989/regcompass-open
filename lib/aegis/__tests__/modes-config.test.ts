import { describe, it, expect, vi, afterEach } from 'vitest';
import { getModeSpec } from '../modes';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mode output/iteration ceilings — single source of truth (modes.ts)', () => {
  it('defaults: structured modes 16384 tokens, CONVERSATIONAL 8192', () => {
    expect(getModeSpec('ASSESS', 'de').maxTokens).toBe(16384);
    expect(getModeSpec('GAP_ANALYZE', 'de').maxTokens).toBe(16384);
    expect(getModeSpec('CONVERSATIONAL', 'de').maxTokens).toBe(8192);
  });

  it('defaults: iteration ceilings per mode', () => {
    expect(getModeSpec('CONVERSATIONAL', 'de').maxIterations).toBe(10);
    expect(getModeSpec('ASSESS', 'de').maxIterations).toBe(15);
    expect(getModeSpec('GAP_ANALYZE', 'de').maxIterations).toBe(25);
  });

  it('env overrides are honoured (AEGIS_MAX_TOKENS_* / AEGIS_MAX_ITERATIONS_*)', async () => {
    vi.stubEnv('AEGIS_MAX_TOKENS_ASSESS', '5000');
    vi.stubEnv('AEGIS_MAX_ITERATIONS_ASSESS', '7');
    vi.resetModules();
    const { getModeSpec: fresh } = await import('../modes');
    expect(fresh('ASSESS', 'de').maxTokens).toBe(5000);
    expect(fresh('ASSESS', 'de').maxIterations).toBe(7);
  });
});

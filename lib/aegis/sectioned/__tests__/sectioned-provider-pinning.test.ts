import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePlan } from '../plan';
import { maybeGlueIntro } from '../assemble';
import { generateSectionDigest } from '../section-digest';
import { getProviderFor } from '../../providers/registry';
import {
  assertModelForProvider,
  jobProviderForRuntime,
  runtimeProviderForJob,
  AegisProviderModelMismatchError,
  AegisJobProviderMissingError,
  AegisGeminiCapabilityNotReadyError,
  AegisCodexRuntimePendingError,
} from '../../runtime-selection';
import { createJob } from '../job-store';
import { makeStubDb, PLAN } from './stub-db';
import { MODEL_IDS } from '../../types';

/**
 * Adversarial: the flag-gated Sectioned pipeline's planning and assembly model
 * calls must obey the SAME frozen request-level provider selection as the rest
 * of AEGIS. A hostile `AEGIS_BRAIN` (naming another provider) must NOT override
 * an explicit selection. Gemini/Codex stay gated — only the pinning is exercised.
 *
 * The Sectioned pipeline is reachable only from the STREAMING path
 * (`runAegisStreaming`; the sectioned candidate requires a deadline), so there is
 * no non-streaming sectioned path to cover.
 */

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe('Sectioned planning is pinned to the selected provider', () => {
  it('threads the Anthropic selection into the plan call even when AEGIS_BRAIN=gemini', async () => {
    process.env.AEGIS_BRAIN = 'gemini'; // hostile
    const call = vi.fn().mockResolvedValue({ value: {}, usage: USAGE });
    // Plan validation may reject the empty value; the model call already happened.
    await generatePlan('Analysiere DORA.', 'de', 'anthropic', { call }).catch(() => {});
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].provider).toBe('anthropic');
    // Credential isolation: the plan call smuggles no cross-provider key — the
    // resolved (anthropic) provider uses only its own env key.
    expect(call.mock.calls[0][0].apiKey).toBeUndefined();
  });

  it('dev fallback: with NO provider context the plan call passes provider undefined', async () => {
    process.env.AEGIS_BRAIN = 'gemini';
    const call = vi.fn().mockResolvedValue({ value: {}, usage: USAGE });
    await generatePlan('x', 'de', undefined, { call }).catch(() => {});
    expect(call.mock.calls[0][0].provider).toBeUndefined();
  });
});

describe('Sectioned assembly (glue) is pinned to the selected provider', () => {
  it('threads the Anthropic selection into the glue call even when AEGIS_BRAIN=gemini', async () => {
    process.env.AEGIS_BRAIN = 'gemini';
    process.env.AEGIS_GLUE_PASS_ENABLED = '1';
    const call = vi.fn().mockResolvedValue({ text: 'Einleitung.', usage: USAGE });
    const report = { text: 'REPORT', citations: [], dedupedBlocks: 0 } as never;
    await maybeGlueIntro(report, ['Abschnitt 1'], 'anthropic', undefined, call as never);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].provider).toBe('anthropic');
    expect(call.mock.calls[0][0].apiKey).toBeUndefined();
  });
});

describe('Sectioned per-section digest is pinned to the selected provider', () => {
  it('threads the Anthropic selection into the digest call even when AEGIS_BRAIN=gemini', async () => {
    process.env.AEGIS_BRAIN = 'gemini'; // hostile
    const call = vi
      .fn()
      .mockResolvedValue({ value: { claims: [], citedRegs: [], definedTerms: [], openReferences: [] }, usage: USAGE });
    await generateSectionDigest('Ein Abschnitt mit [R-DORA-024].', { call, provider: 'anthropic' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].provider).toBe('anthropic');
    // Credential isolation: no cross-provider key — the resolved (anthropic)
    // provider uses only its own env key; no Gemini credential is read.
    expect(call.mock.calls[0][0].apiKey).toBeUndefined();
  });
});

describe('The threaded provider decides dispatch (not AEGIS_BRAIN)', () => {
  it('an Anthropic selection dispatches Anthropic even when AEGIS_BRAIN=gemini', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    // Sectioned plan/glue call → callStructured/callHaiku → getProviderFor(provider, model).
    expect(getProviderFor('anthropic', MODEL_IDS.sonnet).id).toBe('anthropic');
    expect(getProviderFor('anthropic', MODEL_IDS.haiku).id).toBe('anthropic');
  });

  it('the dev fallback still applies ONLY when no provider is threaded', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    expect(getProviderFor(undefined, MODEL_IDS.sonnet).id).toBe('gemini');
    delete process.env.AEGIS_BRAIN;
    expect(getProviderFor(undefined, MODEL_IDS.sonnet).id).toBe('anthropic');
  });

  it('provider/model mismatch fails before dispatch', () => {
    expect(() => assertModelForProvider({ provider: 'gemini', model: MODEL_IDS.sonnet })).toThrow(
      AegisProviderModelMismatchError,
    );
    expect(() => assertModelForProvider({ provider: 'anthropic', model: MODEL_IDS.sonnet })).not.toThrow();
  });
});

describe('Sectioned job provider — persisted at creation, frozen across resume', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('persists the frozen provider on the created job (anthropic → anthropic-api)', async () => {
    const stub = makeStubDb();
    await createJob('conv-1', PLAN, jobProviderForRuntime('anthropic'), stub);
    expect(stub.jobs[0].provider).toBe('anthropic-api');
  });

  it('jobProviderForRuntime maps a runtime provider to its canonical three-card value', () => {
    expect(jobProviderForRuntime('anthropic')).toBe('anthropic-api');
    expect(jobProviderForRuntime('gemini')).toBe('gemini-api');
  });

  it('resume restores the provider from the JOB — a later user-preference change cannot switch it', () => {
    // runtimeProviderForJob reads ONLY the persisted value; it never consults
    // User.aegisProvider, so changing the preference after pausing is irrelevant.
    // A hostile AEGIS_BRAIN must not matter either.
    process.env.AEGIS_BRAIN = 'gemini';
    expect(runtimeProviderForJob('anthropic-api', 'de')).toBe('anthropic');
  });

  it('a Gemini or Codex job fails closed on resume with its typed gated error', () => {
    expect(() => runtimeProviderForJob('gemini-api', 'de')).toThrow(AegisGeminiCapabilityNotReadyError);
    expect(() => runtimeProviderForJob('chatgpt-codex', 'de')).toThrow(AegisCodexRuntimePendingError);
  });

  it('a missing or unparseable persisted provider fails closed (never assumed Anthropic)', () => {
    expect(() => runtimeProviderForJob(null, 'de')).toThrow(AegisJobProviderMissingError);
    expect(() => runtimeProviderForJob(undefined, 'de')).toThrow(AegisJobProviderMissingError);
    // A runtime label ('anthropic') is NOT a valid persisted three-card value.
    expect(() => runtimeProviderForJob('anthropic', 'de')).toThrow(AegisJobProviderMissingError);
    expect(() => runtimeProviderForJob('garbage', 'de')).toThrow(AegisJobProviderMissingError);
  });

  it('bilingual: the legacy fail-closed message is localized', () => {
    const msg = (lang: 'de' | 'en') => {
      try {
        runtimeProviderForJob(null, lang);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(msg('de')).toMatch(/fortgesetzt|Provider-Zuordnung/);
    expect(msg('en')).toMatch(/resumed|predates/);
  });

  it('round-trip: a job persisted from an Anthropic run resumes on Anthropic', () => {
    // The end-to-end guarantee: persist(create) then restore(resume) is identity
    // for the active provider — the resumed run dispatches on the same brain.
    const persisted = jobProviderForRuntime('anthropic'); // at creation
    expect(runtimeProviderForJob(persisted, 'de')).toBe('anthropic'); // at resume
  });
});

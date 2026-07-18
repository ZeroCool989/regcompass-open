import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import { assertTtsResidencyAllowed, getTTS } from '../index';
import type { TTSProvider } from '../types';

// Build a VoiceConfig via the real loader from an explicit env map (no
// process.env dependence) — also exercises the loader's German defaults.
function cfg(env: Record<string, string>) {
  return loadConfig(env as NodeJS.ProcessEnv);
}

describe('getTTS — provider selection', () => {
  it('selects Cartesia (third-party) when TTS_PROVIDER=cartesia', () => {
    const tts = getTTS(cfg({ TTS_PROVIDER: 'cartesia' }));
    expect(tts.name).toBe('cartesia');
    expect(tts.residency).toBe('third-party');
  });

  it('selects Kokoro (in-infra) when TTS_PROVIDER=kokoro', () => {
    const tts = getTTS(cfg({ TTS_PROVIDER: 'kokoro' }));
    expect(tts.name).toBe('kokoro');
    expect(tts.residency).toBe('in-infra');
  });

  it('throws on an unknown provider', () => {
    expect(() => getTTS(cfg({ TTS_PROVIDER: 'bogus' }))).toThrow(/Unknown TTS_PROVIDER/);
  });
});

describe('getTTS — residency gate (CLIENT_DATA_MODE)', () => {
  it('REFUSES a third-party provider when CLIENT_DATA_MODE=true', () => {
    expect(() =>
      getTTS(cfg({ TTS_PROVIDER: 'cartesia', CLIENT_DATA_MODE: 'true' })),
    ).toThrow(/third-party.*CLIENT_DATA_MODE=true|Refusing to boot/);
  });

  it('allows an in-infra provider when CLIENT_DATA_MODE=true', () => {
    const tts = getTTS(cfg({ TTS_PROVIDER: 'kokoro', CLIENT_DATA_MODE: 'true' }));
    expect(tts.name).toBe('kokoro');
  });

  it('allows a third-party provider for the internal demo (CLIENT_DATA_MODE=false)', () => {
    const tts = getTTS(cfg({ TTS_PROVIDER: 'cartesia', CLIENT_DATA_MODE: 'false' }));
    expect(tts.name).toBe('cartesia');
  });
});

describe('assertTtsResidencyAllowed (unit)', () => {
  const thirdParty: TTSProvider = {
    name: 'x',
    residency: 'third-party',
    // eslint-disable-next-line require-yield
    async *synthesizeStream() {
      throw new Error('unused');
    },
  };
  const inInfra: TTSProvider = { ...thirdParty, residency: 'in-infra' };

  it('throws for third-party under client data', () => {
    expect(() => assertTtsResidencyAllowed(thirdParty, true)).toThrow();
  });
  it('passes for in-infra under client data', () => {
    expect(() => assertTtsResidencyAllowed(inInfra, true)).not.toThrow();
  });
  it('passes for third-party when not under client data', () => {
    expect(() => assertTtsResidencyAllowed(thirdParty, false)).not.toThrow();
  });
});

describe('loadConfig — German defaults & no Anthropic key', () => {
  it('defaults Whisper to German and Cartesia to sonic-3', () => {
    const c = cfg({});
    expect(c.whisper.language).toBe('de');
    expect(c.tts.cartesia.model).toBe('sonic-3');
  });

  it('exposes no Anthropic key on the gateway config', () => {
    expect(JSON.stringify(cfg({ ANTHROPIC_API_KEY: 'sk-should-be-ignored' }))).not.toContain(
      'sk-should-be-ignored',
    );
  });
});

import type { TTSProvider, TtsResidency, TtsSynthesisOptions } from './types';

/**
 * Kokoro self-hosted TTS — runs in-infra (Hetzner), so residency is "in-infra".
 * This is the target provider before real client data. FOUNDATION STUB: shape +
 * config only; the call to the self-hosted Kokoro server is not implemented yet.
 */
export interface KokoroConfig {
  /** Base URL of the self-hosted Kokoro server. */
  url: string;
  /** Default German voice. */
  voice: string;
}

export class KokoroTTS implements TTSProvider {
  readonly name = 'kokoro';
  readonly residency: TtsResidency = 'in-infra';

  constructor(private readonly config: KokoroConfig) {}

  // eslint-disable-next-line require-yield -- stub: throws before yielding.
  async *synthesizeStream(
    _text: string,
    _opts?: TtsSynthesisOptions,
  ): AsyncIterable<Uint8Array> {
    void this.config;
    throw new Error(
      'KokoroTTS.synthesizeStream is a foundation stub — self-hosted Kokoro ' +
        'synthesis is not implemented yet.',
    );
  }
}

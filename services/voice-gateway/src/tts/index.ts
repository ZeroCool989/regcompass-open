import type { VoiceConfig } from '../config';
import { CartesiaTTS } from './cartesia';
import { KokoroTTS } from './kokoro';
import type { TTSProvider } from './types';

export type { TTSProvider, TtsResidency, TtsSynthesisOptions } from './types';
export { CartesiaTTS } from './cartesia';
export { KokoroTTS } from './kokoro';

/**
 * Residency gate. A third-party (cloud) TTS is fine for the internal demo but
 * MUST NOT process real client audio output — refuse to boot with one once
 * CLIENT_DATA_MODE=true. Exported so a future startup check can call it directly.
 */
export function assertTtsResidencyAllowed(
  provider: TTSProvider,
  clientDataMode: boolean,
): void {
  if (clientDataMode && provider.residency === 'third-party') {
    throw new Error(
      `Refusing to boot: TTS provider "${provider.name}" is third-party ` +
        `(residency=third-party) but CLIENT_DATA_MODE=true. Switch to an ` +
        `in-infra provider (e.g. self-hosted Kokoro) before processing client data.`,
    );
  }
}

/**
 * Select the configured TTS provider and enforce the residency gate. Throws on
 * an unknown provider name or a residency violation — both are boot failures.
 */
export function getTTS(config: VoiceConfig): TTSProvider {
  let provider: TTSProvider;
  switch (config.tts.provider) {
    case 'cartesia':
      provider = new CartesiaTTS(config.tts.cartesia);
      break;
    case 'kokoro':
      provider = new KokoroTTS(config.tts.kokoro);
      break;
    default:
      throw new Error(`Unknown TTS_PROVIDER: ${String(config.tts.provider)}`);
  }
  assertTtsResidencyAllowed(provider, config.clientDataMode);
  return provider;
}

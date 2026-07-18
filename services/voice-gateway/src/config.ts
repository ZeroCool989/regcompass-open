/**
 * Voice-gateway configuration. Loaded once at boot from the environment.
 *
 * Residency note: user audio is processed in-infra (self-hosted faster-whisper
 * on Hetzner). The TTS engine is the one swappable, audited boundary — cloud is
 * allowed for the internal demo, but a third-party TTS must be refused once
 * CLIENT_DATA_MODE=true (see lib `assertTtsResidencyAllowed`).
 *
 * This gateway holds NO Anthropic key: voice routes THROUGH the AEGIS brain
 * (/api/aegis), which already owns the key, intent routing, KB grounding, the
 * verify step, citations, and conversation memory. The gateway only needs a
 * service token to reach AEGIS.
 */

export type TtsProviderName = 'cartesia' | 'kokoro';

export interface VoiceConfig {
  /** Public, demo-internal flag: when true, third-party TTS is refused at boot. */
  clientDataMode: boolean;

  /** The AEGIS brain the gateway calls instead of Claude directly. */
  aegis: {
    /** Base URL of the Next app, e.g. https://regcompass-ebon.vercel.app */
    bridgeUrl: string;
    /** Service-to-service bearer token (validated by AEGIS — see proposal). */
    serviceToken: string;
  };

  /** Self-hosted STT (faster-whisper). German by default. */
  whisper: {
    url: string;
    model: string;
    language: string;
  };

  /** TTS seam — provider chosen by name; per-provider settings below. */
  tts: {
    provider: TtsProviderName;
    cartesia: { apiKey: string; model: string; voiceId: string };
    kokoro: { url: string; voice: string };
  };

  /** Shared secret authenticating browser WSS clients to the gateway. */
  wssSecret: string;

  port: number;
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function str(v: string | undefined, fallback = ''): string {
  return v ?? fallback;
}

/**
 * Build the typed config from a raw env map (defaults to process.env). Pure —
 * takes the env in so it is trivially testable. Does NOT assert completeness;
 * boot-time validation lives alongside the residency check.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const provider = str(env.TTS_PROVIDER, 'cartesia') as TtsProviderName;
  return {
    clientDataMode: bool(env.CLIENT_DATA_MODE, false),
    aegis: {
      bridgeUrl: str(env.AEGIS_BRIDGE_URL),
      serviceToken: str(env.AEGIS_SERVICE_TOKEN),
    },
    whisper: {
      url: str(env.WHISPER_URL),
      model: str(env.WHISPER_MODEL, 'large-v3'),
      language: str(env.WHISPER_LANGUAGE, 'de'),
    },
    tts: {
      provider,
      cartesia: {
        apiKey: str(env.CARTESIA_API_KEY),
        model: str(env.CARTESIA_MODEL, 'sonic-3'),
        voiceId: str(env.CARTESIA_VOICE_ID),
      },
      kokoro: {
        url: str(env.KOKORO_URL),
        voice: str(env.KOKORO_VOICE, 'de'),
      },
    },
    wssSecret: str(env.GATEWAY_WSS_SECRET),
    port: Number(env.PORT ?? '8787'),
  };
}

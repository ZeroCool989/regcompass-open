import type { TTSProvider, TtsResidency, TtsSynthesisOptions } from './types';

/**
 * Cartesia (sonic-3) German TTS — cloud, so residency is "third-party".
 * FOUNDATION SKELETON: shape + config only; the streaming WS/HTTP synth call is
 * deliberately not implemented yet (no SDK dependency pulled in at this step).
 *
 * Allowed for the internal demo; refused at boot once CLIENT_DATA_MODE=true
 * (see assertTtsResidencyAllowed). Replace with an in-infra provider before
 * client data.
 */
export interface CartesiaConfig {
  apiKey: string;
  /** Cartesia model id; the German loop uses "sonic-3". */
  model: string;
  /** Default voice id when an option doesn't override it. */
  voiceId: string;
}

export class CartesiaTTS implements TTSProvider {
  readonly name = 'cartesia';
  readonly residency: TtsResidency = 'third-party';

  constructor(private readonly config: CartesiaConfig) {}

  async *synthesizeStream(
    text: string,
    opts?: TtsSynthesisOptions,
  ): AsyncIterable<Uint8Array> {
    // One-shot /tts/bytes; we stream the HTTP response body so first-chunk
    // arrival approximates first-audio latency. Output format (wav/pcm_s16le)
    // is fixed here for now — a normalized format is a later decision.
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': '2026-03-01',
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: this.config.model,
        transcript: text,
        voice: { mode: 'id', id: opts?.voiceId ?? this.config.voiceId },
        language: opts?.language ?? 'de',
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 48000 },
      }),
      signal: opts?.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cartesia TTS ${res.status}: ${detail.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  }
}

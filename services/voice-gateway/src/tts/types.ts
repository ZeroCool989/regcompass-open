/**
 * TTS provider seam — the one swappable, audited boundary for voice output.
 *
 * `residency` is the audit flag the boot-time check keys on: a `third-party`
 * provider (cloud) is allowed for the internal demo but MUST be refused once
 * real client data is in play (CLIENT_DATA_MODE=true). Swapping to an
 * `in-infra` provider (self-hosted on Hetzner) is then a config change, not a
 * code change.
 */

export type TtsResidency = 'in-infra' | 'third-party';

export interface TtsSynthesisOptions {
  /** BCP-47-ish language tag; the German loop passes "de". */
  language?: string;
  /** Provider-specific voice id; falls back to the provider's configured voice. */
  voiceId?: string;
  /** Abort to support later barge-in (cancel synth when the user speaks). */
  signal?: AbortSignal;
}

export interface TTSProvider {
  /** Stable id used by getTTS() / logging, e.g. "cartesia" | "kokoro". */
  readonly name: string;
  /** Where audio synthesis happens — gates third-party use under client data. */
  readonly residency: TtsResidency;
  /**
   * Stream synthesized audio for `text` as it is produced, so playback can
   * start mid-answer. Chunks are raw audio bytes (encoding is provider-defined
   * for now; a normalized format is a later decision).
   */
  synthesizeStream(text: string, opts?: TtsSynthesisOptions): AsyncIterable<Uint8Array>;
}

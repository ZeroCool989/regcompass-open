import { describe, expect, it } from 'vitest';
import {
  AEGIS_VOICES,
  BROWSER_VOICE_ID,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_PREFS,
  isValidVoiceId,
  normalizeVoicePrefs,
  RECOMMENDED_VOICE,
  resolveVoiceId,
  voiceById,
} from '@/lib/aegis/voices';

describe('voice catalog', () => {
  it('default is the recommended browser voice (German)', () => {
    expect(DEFAULT_VOICE_ID).toBe(BROWSER_VOICE_ID);
    expect(RECOMMENDED_VOICE.id).toBe(DEFAULT_VOICE_ID);
    expect(RECOMMENDED_VOICE.provider).toBe('browser');
    expect(RECOMMENDED_VOICE.language).toBe('de');
  });

  it('exactly one voice is marked recommended', () => {
    expect(AEGIS_VOICES.filter((v) => v.recommended)).toHaveLength(1);
  });

  it('contains only browser (Web Speech) voices — no cloud provider', () => {
    expect(AEGIS_VOICES.every((v) => v.provider === 'browser')).toBe(true);
    expect(voiceById(BROWSER_VOICE_ID)?.provider).toBe('browser');
  });

  it('resolveVoiceId falls back to the default', () => {
    expect(resolveVoiceId(null)).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceId('')).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceId('browser:com.apple.voice.Anna')).toBe('browser:com.apple.voice.Anna');
  });

  it('resolveVoiceId maps legacy cloud-provider tokens to the default', () => {
    expect(resolveVoiceId('cartesia:b7187e84-fe22-4344-ba4a-bc013fcb533e')).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceId('garbage')).toBe(DEFAULT_VOICE_ID);
  });

  it('validates browser tokens and null; rejects unknown/legacy ids', () => {
    expect(isValidVoiceId(null)).toBe(true);
    expect(isValidVoiceId(DEFAULT_VOICE_ID)).toBe(true);
    expect(isValidVoiceId(BROWSER_VOICE_ID)).toBe(true);
    expect(isValidVoiceId('browser:com.apple.voice.Anna')).toBe(true);
    expect(isValidVoiceId('cartesia:not-a-real-voice')).toBe(false);
    expect(isValidVoiceId('garbage')).toBe(false);
  });
});

describe('voice prefs', () => {
  it('defaults are sensible', () => {
    expect(DEFAULT_VOICE_PREFS).toMatchObject({ rate: 1, volume: 1, autoRead: false, pushToTalk: false, vad: true });
  });

  it('normalizeVoicePrefs clamps and fills defaults', () => {
    expect(normalizeVoicePrefs({})).toEqual(DEFAULT_VOICE_PREFS);
    expect(normalizeVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS);
    const p = normalizeVoicePrefs({ rate: 5, volume: 2, autoRead: 'yes', pushToTalk: true, vad: false });
    expect(p.rate).toBe(2);
    expect(p.volume).toBe(1);
    expect(p.autoRead).toBe(false); // non-boolean → default
    expect(p.pushToTalk).toBe(true);
    expect(p.vad).toBe(false);
  });

  it('clamps the low end too', () => {
    expect(normalizeVoicePrefs({ rate: 0.1, volume: -3 })).toMatchObject({ rate: 0.5, volume: 0 });
  });
});

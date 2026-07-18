import { describe, expect, it } from 'vitest';
import {
  AEGIS_VOICES,
  BROWSER_VOICE_ID,
  cartesiaVoiceId,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_PREFS,
  isValidVoiceId,
  normalizeVoicePrefs,
  RECOMMENDED_VOICE,
  resolveVoiceId,
  voiceById,
} from '@/lib/aegis/voices';
import { DEFAULT_CARTESIA_VOICE_ID } from '@/lib/aegis/cartesia-voices';

describe('voice catalog', () => {
  it('default is the recommended Sebastian voice (masculine, German)', () => {
    expect(DEFAULT_VOICE_ID).toBe(cartesiaVoiceId(DEFAULT_CARTESIA_VOICE_ID));
    expect(RECOMMENDED_VOICE.id).toBe(DEFAULT_VOICE_ID);
    expect(RECOMMENDED_VOICE.name).toBe('Sebastian');
    expect(RECOMMENDED_VOICE.gender).toBe('masculine');
    expect(RECOMMENDED_VOICE.language).toBe('de');
  });

  it('exactly one voice is marked recommended', () => {
    expect(AEGIS_VOICES.filter((v) => v.recommended)).toHaveLength(1);
  });

  it('includes German Cartesia voices and a provider-agnostic browser option', () => {
    expect(AEGIS_VOICES.some((v) => v.provider === 'cartesia' && v.language === 'de')).toBe(true);
    expect(voiceById(BROWSER_VOICE_ID)?.provider).toBe('browser');
  });

  it('resolveVoiceId falls back to the default', () => {
    expect(resolveVoiceId(null)).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceId('')).toBe(DEFAULT_VOICE_ID);
    expect(resolveVoiceId('cartesia:abc')).toBe('cartesia:abc');
  });

  it('validates known ids, browser tokens, and null; rejects unknown', () => {
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

import { describe, it, expect } from 'vitest';
import {
  chunkParagraphs,
  normalizeLang,
  isAlreadyTarget,
  detectLanguage,
  translateText,
  type DeeplLike,
} from '../deepl';

/** Fake DeepL client that records calls and echoes the target into the text. */
function fakeClient(detected = 'es') {
  const calls: { texts: string[]; targetLang: string }[] = [];
  const client: DeeplLike = {
    async translateText(texts, _src, targetLang) {
      calls.push({ texts: [...texts], targetLang });
      return texts.map((t) => ({ text: `[${targetLang}] ${t}`, detectedSourceLang: detected })) as never;
    },
  };
  return { client, calls };
}

describe('normalizeLang / isAlreadyTarget', () => {
  it('normalizes to a 2-letter uppercase base', () => {
    expect(normalizeLang('en-US')).toBe('EN');
    expect(normalizeLang('de')).toBe('DE');
    expect(normalizeLang('pt-BR')).toBe('PT');
    expect(normalizeLang(null)).toBeNull();
  });
  it('detects already-target documents', () => {
    expect(isAlreadyTarget('de', 'DE')).toBe(true);
    expect(isAlreadyTarget('en-GB', 'EN')).toBe(true);
    expect(isAlreadyTarget('es', 'DE')).toBe(false);
  });
});

describe('chunkParagraphs', () => {
  it('keeps small text as one chunk', () => {
    expect(chunkParagraphs('Absatz eins.\n\nAbsatz zwei.')).toHaveLength(1);
  });
  it('hard-splits an oversized single paragraph', () => {
    const big = 'x'.repeat(200_000);
    const chunks = chunkParagraphs(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(80_000);
  });
});

describe('detectLanguage', () => {
  it('reads detectedSourceLang from a sample translation', async () => {
    const { client, calls } = fakeClient('fr');
    expect(await detectLanguage('Le texte en français.', client)).toBe('FR');
    expect(calls[0].targetLang).toBe('en-US'); // sample translated to EN
  });
  it('returns null for empty input', async () => {
    const { client } = fakeClient();
    expect(await detectLanguage('   ', client)).toBeNull();
  });
});

describe('translateText', () => {
  it('maps DE→de and EN→en-US and joins chunks', async () => {
    const { client, calls } = fakeClient('es');
    const de = await translateText('Uno.\n\nDos.', 'DE', client);
    expect(calls[0].targetLang).toBe('de');
    expect(de.detectedSourceLang).toBe('ES');
    expect(de.text).toContain('[de] Uno.');

    const en = await translateText('Hola.', 'EN', client);
    expect(calls[1].targetLang).toBe('en-US');
    expect(en.text).toContain('[en-US] Hola.');
  });
  it('returns empty for empty input', async () => {
    const { client } = fakeClient();
    expect(await translateText('', 'DE', client)).toEqual({ text: '', detectedSourceLang: null });
  });
  it('batches many chunks into multiple requests', async () => {
    const { client, calls } = fakeClient();
    // 60 large paragraphs → exceeds the 40-text / size caps → >1 request.
    const text = Array.from({ length: 60 }, (_, i) => `${'p'.repeat(3000)}${i}`).join('\n\n');
    await translateText(text, 'EN', client);
    expect(calls.length).toBeGreaterThan(1);
  });
});

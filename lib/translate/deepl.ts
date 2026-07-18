import * as deepl from 'deepl-node';
import { TRANSLATION_TARGETS, isSupportedTarget } from './targets';

/**
 * Thin wrapper around the official DeepL SDK — the single translation backend
 * for AEGIS Translate. Translates the EXTRACTED text (never the PDF), in
 * paragraph-sized chunks that respect DeepL's per-request size limits. The
 * DeepL client is injectable so the pipeline is unit-testable without network.
 *
 * Target languages = the full DeepL target set (see ./targets). Source is any
 * DeepL-detected language. `detectLanguage` always samples to English.
 */

export { isSupportedTarget };

/** Stable target key (e.g. "DE", "FR", "ZH") → exact DeepL target code. */
const DEEPL_CODE = new Map(TRANSLATION_TARGETS.map((t) => [t.code, t.deepl as deepl.TargetLanguageCode]));
const DETECT_TARGET = 'en-US' as deepl.TargetLanguageCode;

/** Resolve a stable target key to its DeepL code (throws on unsupported). */
export function targetDeeplCode(target: string): deepl.TargetLanguageCode {
  const code = DEEPL_CODE.get(target.toUpperCase());
  if (!code) throw new Error('unsupported_target');
  return code;
}

// DeepL request limits (conservative): keep each request well under the
// ~128 KiB body cap and the 50-texts-per-request cap.
const MAX_CHUNK_CHARS = 80_000;
const MAX_REQUEST_CHARS = 110_000;
const MAX_TEXTS_PER_REQUEST = 40;
const DETECT_SAMPLE_CHARS = 400;

/** Minimal surface we use — lets tests inject a fake client. */
export interface DeeplLike {
  translateText(
    texts: string[],
    sourceLang: deepl.SourceLanguageCode | null,
    targetLang: deepl.TargetLanguageCode,
    options?: deepl.TranslateTextOptions,
  ): Promise<deepl.TextResult[]>;
}

export function isTranslationConfigured(): boolean {
  return !!process.env.DEEPL_API_KEY && process.env.DEEPL_API_KEY.trim().length > 0;
}

let cached: DeeplLike | null = null;

/** The real DeepL client (Free vs Pro endpoint auto-selected by key suffix). */
export function getTranslator(): DeeplLike {
  const key = process.env.DEEPL_API_KEY;
  if (!key || !key.trim()) throw new Error('deepl_not_configured');
  if (cached) return cached;
  const translator = new deepl.Translator(key.trim());
  cached = {
    translateText: (texts, sourceLang, targetLang, options) =>
      translator.translateText(texts, sourceLang, targetLang, options),
  };
  return cached;
}

/** Normalize a DeepL language code to a 2-letter uppercase base (e.g. en-US → EN). */
export function normalizeLang(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.trim().slice(0, 2).toUpperCase();
  return base.length === 2 ? base : null;
}

/** True when the detected source language already equals the requested target. */
export function isAlreadyTarget(detected: string | null, target: string): boolean {
  return normalizeLang(detected) === target.toUpperCase();
}

// ───────────────────────── Chunking ─────────────────────────

/** Split text into paragraph chunks no larger than MAX_CHUNK_CHARS. */
export function chunkParagraphs(text: string): string[] {
  const paras = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) chunks.push(buf);
    buf = '';
  };
  for (const para of paras) {
    if (para.length > MAX_CHUNK_CHARS) {
      // A single oversized paragraph — hard-split it.
      flush();
      for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS) {
        chunks.push(para.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }
    if (buf.length + para.length + 2 > MAX_CHUNK_CHARS) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

/** Group chunks into request batches under the size/count caps. */
function batchChunks(chunks: string[]): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const c of chunks) {
    if (cur.length > 0 && (size + c.length > MAX_REQUEST_CHARS || cur.length >= MAX_TEXTS_PER_REQUEST)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += c.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ───────────────────────── Public API ─────────────────────────

export type TranslateResult = {
  text: string;
  detectedSourceLang: string | null; // normalized 2-letter base (e.g. "ES")
};

/**
 * Detect the source language of a document via a small sample (DeepL has no
 * standalone detect endpoint; we read `detectedSourceLang` from a tiny
 * translation). Returns the normalized 2-letter base, or null on empty input.
 */
export async function detectLanguage(text: string, client: DeeplLike = getTranslator()): Promise<string | null> {
  const sample = text.trim().slice(0, DETECT_SAMPLE_CHARS);
  if (!sample) return null;
  const [res] = await client.translateText([sample], null, DETECT_TARGET);
  return normalizeLang(res?.detectedSourceLang);
}

/**
 * Translate the full text into the target language (any supported DeepL target),
 * chunked + batched to respect DeepL limits. Returns the joined translation +
 * detected source lang.
 */
export async function translateText(
  text: string,
  target: string,
  client: DeeplLike = getTranslator(),
): Promise<TranslateResult> {
  const targetCode = targetDeeplCode(target);
  const chunks = chunkParagraphs(text);
  if (chunks.length === 0) return { text: '', detectedSourceLang: null };

  const out: string[] = [];
  let detected: string | null = null;
  for (const batch of batchChunks(chunks)) {
    const results = await client.translateText(batch, null, targetCode);
    if (detected === null && results[0]) detected = normalizeLang(results[0].detectedSourceLang);
    for (const r of results) out.push(r.text);
  }
  return { text: out.join('\n\n'), detectedSourceLang: detected };
}

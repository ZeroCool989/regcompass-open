/**
 * Supported DeepL TARGET languages for AEGIS Translate.
 *
 * Client-safe: this module holds only plain metadata (no `deepl-node` import),
 * so it can be used in both the UI and the server. `code` is the stable 2-letter
 * key we store/validate; `deepl` is the exact DeepL target code passed to the
 * SDK. Source languages are unrestricted (DeepL auto-detects any).
 *
 * The translation Quality Check (obligation strength + term consistency) is
 * currently tuned for DE/EN targets only; other targets translate fine but
 * without those extra warnings.
 */

export type TranslationTargetMeta = {
  /** Stable 2-letter key we persist + validate (uppercase). */
  code: string;
  /** Exact DeepL target language code (case-insensitive on the API). */
  deepl: string;
  /** Display label (German). */
  label: string;
  /** Flag emoji for the picker. */
  flag: string;
};

// DE + EN first (most common), then alphabetical by label.
export const TRANSLATION_TARGETS: TranslationTargetMeta[] = [
  { code: 'DE', deepl: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'EN', deepl: 'en-US', label: 'Englisch', flag: '🇬🇧' },
  { code: 'AR', deepl: 'ar', label: 'Arabisch', flag: '🇸🇦' },
  { code: 'BG', deepl: 'bg', label: 'Bulgarisch', flag: '🇧🇬' },
  { code: 'ZH', deepl: 'zh', label: 'Chinesisch', flag: '🇨🇳' },
  { code: 'DA', deepl: 'da', label: 'Dänisch', flag: '🇩🇰' },
  { code: 'ET', deepl: 'et', label: 'Estnisch', flag: '🇪🇪' },
  { code: 'FI', deepl: 'fi', label: 'Finnisch', flag: '🇫🇮' },
  { code: 'FR', deepl: 'fr', label: 'Französisch', flag: '🇫🇷' },
  { code: 'EL', deepl: 'el', label: 'Griechisch', flag: '🇬🇷' },
  { code: 'ID', deepl: 'id', label: 'Indonesisch', flag: '🇮🇩' },
  { code: 'IT', deepl: 'it', label: 'Italienisch', flag: '🇮🇹' },
  { code: 'JA', deepl: 'ja', label: 'Japanisch', flag: '🇯🇵' },
  { code: 'KO', deepl: 'ko', label: 'Koreanisch', flag: '🇰🇷' },
  { code: 'HR', deepl: 'hr', label: 'Kroatisch', flag: '🇭🇷' },
  { code: 'LV', deepl: 'lv', label: 'Lettisch', flag: '🇱🇻' },
  { code: 'LT', deepl: 'lt', label: 'Litauisch', flag: '🇱🇹' },
  { code: 'NL', deepl: 'nl', label: 'Niederländisch', flag: '🇳🇱' },
  { code: 'NB', deepl: 'nb', label: 'Norwegisch', flag: '🇳🇴' },
  { code: 'PL', deepl: 'pl', label: 'Polnisch', flag: '🇵🇱' },
  { code: 'PT', deepl: 'pt-PT', label: 'Portugiesisch', flag: '🇵🇹' },
  { code: 'RO', deepl: 'ro', label: 'Rumänisch', flag: '🇷🇴' },
  { code: 'RU', deepl: 'ru', label: 'Russisch', flag: '🇷🇺' },
  { code: 'SV', deepl: 'sv', label: 'Schwedisch', flag: '🇸🇪' },
  { code: 'SK', deepl: 'sk', label: 'Slowakisch', flag: '🇸🇰' },
  { code: 'SL', deepl: 'sl', label: 'Slowenisch', flag: '🇸🇮' },
  { code: 'ES', deepl: 'es', label: 'Spanisch', flag: '🇪🇸' },
  { code: 'CS', deepl: 'cs', label: 'Tschechisch', flag: '🇨🇿' },
  { code: 'TR', deepl: 'tr', label: 'Türkisch', flag: '🇹🇷' },
  { code: 'UK', deepl: 'uk', label: 'Ukrainisch', flag: '🇺🇦' },
  { code: 'HU', deepl: 'hu', label: 'Ungarisch', flag: '🇭🇺' },
];

const BY_CODE = new Map(TRANSLATION_TARGETS.map((t) => [t.code, t]));

export function isSupportedTarget(code: string | null | undefined): boolean {
  return !!code && BY_CODE.has(code.toUpperCase());
}

export function targetMeta(code: string): TranslationTargetMeta | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function targetLabel(code: string): string {
  return BY_CODE.get(code.toUpperCase())?.label ?? code.toUpperCase();
}

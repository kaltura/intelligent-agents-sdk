/**
 * Language and script helpers for the doctor checks. PURE: no network, never
 * throw. The SDK has no list of languages the platform supports, so these
 * answer one question only: do two values name the same language, and does a
 * text use the script that language is written in.
 */
import { LANGUAGE_CODES } from '../languages.js';
import { LANGUAGE_NAMES } from '../set-forced-language.js';

/** Legacy ISO 639 codes that still turn up in stored configs. */
const ALIASES = Object.freeze({ iw: 'he', in: 'id', ji: 'yi' });

/** Codes that name one written language. */
const SAME_AS = Object.freeze({ nb: 'no', nn: 'no' });

/** Display name (lower case) to code. */
const CODE_BY_NAME = new Map(Object.entries(LANGUAGE_NAMES).map(([code, name]) => [name.toLowerCase(), code]));

/**
 * Reduce a language code or name to one ISO 639-1 code, or `null` when it is
 * not recognized. Accepts codes (`he`), region tags (`he-IL`, `pt_BR`), the
 * legacy codes `iw`, `in` and `ji`, and the English names in `LANGUAGE_NAMES`
 * (`Hebrew`). Norwegian `nb` and `nn` become `no`. PURE.
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeLanguage(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const base = text.split(/[-_]/)[0];
  const code = ALIASES[/** @type {keyof typeof ALIASES} */ (base)] ?? base;
  if (/** @type {readonly string[]} */ (LANGUAGE_CODES).includes(code)) return SAME_AS[/** @type {keyof typeof SAME_AS} */ (code)] ?? code;
  return CODE_BY_NAME.get(text) ?? null;
}

/**
 * True when both values are recognized and name the same language. An
 * unrecognized value is never a mismatch, so the caller skips its check. PURE.
 * @param {unknown} a @param {unknown} b
 * @returns {boolean|null} `null` when either value is not recognized.
 */
export function sameLanguage(a, b) {
  const x = normalizeLanguage(a);
  const y = normalizeLanguage(b);
  return x === null || y === null ? null : x === y;
}

/** Written script of the languages whose script is not Latin. */
const SCRIPT_BY_LANGUAGE = Object.freeze({
  he: 'Hebrew', yi: 'Hebrew', ar: 'Arabic', fa: 'Arabic', ur: 'Arabic', ps: 'Arabic',
  ru: 'Cyrillic', uk: 'Cyrillic', bg: 'Cyrillic', be: 'Cyrillic', mk: 'Cyrillic',
  el: 'Greek', hy: 'Armenian', ka: 'Georgian', th: 'Thai', ko: 'Hangul', ja: 'Japanese', zh: 'Han',
  hi: 'Devanagari', mr: 'Devanagari', ne: 'Devanagari', sa: 'Devanagari',
  bn: 'Bengali', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', gu: 'Gujarati',
  si: 'Sinhala', my: 'Myanmar', km: 'Khmer', lo: 'Lao', am: 'Ethiopic', ti: 'Ethiopic', bo: 'Tibetan', dv: 'Thaana',
});

/**
 * Widely used languages written in Latin. A language in neither table (for
 * example Serbian, which uses two scripts) has no script, so no check is made.
 */
const LATIN_LANGUAGES = new Set((
  'en es fr de it pt nl sv da no fi is et lv lt pl cs sk sl hr bs ro hu tr sq ca gl eu cy ga gd mt af sw id ms vi tl lb fo'
).split(' '));

/**
 * The script a language is normally written in, as a name from
 * {@link dominantScript}, or `null` when the language is unknown or is written
 * in several scripts. PURE.
 * @param {unknown} language A code or name.
 * @returns {string|null}
 */
export function scriptOfLanguage(language) {
  const code = normalizeLanguage(language);
  if (code === null) return null;
  return SCRIPT_BY_LANGUAGE[/** @type {keyof typeof SCRIPT_BY_LANGUAGE} */ (code)] ?? (LATIN_LANGUAGES.has(code) ? 'Latin' : null);
}

/**
 * Scripts counted by {@link dominantScript}, with the Unicode property each one uses.
 * @type {ReadonlyArray<readonly [string, RegExp]>}
 */
const SCRIPTS = Object.freeze([
  ['Latin', /\p{Script=Latin}/u], ['Hebrew', /\p{Script=Hebrew}/u], ['Arabic', /\p{Script=Arabic}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u], ['Armenian', /\p{Script=Armenian}/u],
  ['Georgian', /\p{Script=Georgian}/u], ['Thai', /\p{Script=Thai}/u], ['Hangul', /\p{Script=Hangul}/u],
  ['Kana', /\p{Script=Hiragana}|\p{Script=Katakana}/u], ['Han', /\p{Script=Han}/u],
  ['Devanagari', /\p{Script=Devanagari}/u], ['Bengali', /\p{Script=Bengali}/u], ['Tamil', /\p{Script=Tamil}/u],
  ['Telugu', /\p{Script=Telugu}/u], ['Kannada', /\p{Script=Kannada}/u], ['Malayalam', /\p{Script=Malayalam}/u],
  ['Gujarati', /\p{Script=Gujarati}/u], ['Sinhala', /\p{Script=Sinhala}/u], ['Myanmar', /\p{Script=Myanmar}/u],
  ['Khmer', /\p{Script=Khmer}/u], ['Lao', /\p{Script=Lao}/u], ['Ethiopic', /\p{Script=Ethiopic}/u],
  ['Tibetan', /\p{Script=Tibetan}/u], ['Thaana', /\p{Script=Thaana}/u],
]);

/** Letters a text needs before its script means anything. */
const MIN_LETTERS = 5;

/**
 * Remove what is not prose: `{{ }}` and `{% %}` template code, `{# #}`
 * comments, URLs and `<tags>`. PURE.
 * @param {string} text
 * @returns {string}
 */
export function stripTemplateSyntax(text) {
  return text.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}|\{#[\s\S]*?#\}|<[^>]*>|https?:\/\/\S+/g, ' ');
}

/**
 * The script most letters of `text` are written in, after template code and
 * URLs are removed. Names in another script do not change the result, because
 * the majority wins. Japanese text (any kana) counts its Han letters as
 * Japanese. Returns `null` for fewer than five letters. PURE.
 * @param {unknown} text
 * @returns {string|null}
 */
export function dominantScript(text) {
  if (typeof text !== 'string') return null;
  /** @type {Map<string, number>} */
  const counts = new Map();
  let letters = 0;
  for (const ch of stripTemplateSyntax(text)) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    const hit = SCRIPTS.find(([, re]) => re.test(ch));
    if (hit) counts.set(hit[0], (counts.get(hit[0]) ?? 0) + 1);
  }
  if (letters < MIN_LETTERS || counts.size === 0) return null;
  if (counts.has('Kana')) {
    counts.set('Japanese', (counts.get('Kana') ?? 0) + (counts.get('Han') ?? 0));
    counts.delete('Kana');
    counts.delete('Han');
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

/**
 * True when a text script fits a language script. Han and Japanese fit each
 * other, because Japanese text without kana is Han. PURE.
 * @param {string} textScript A result of {@link dominantScript}.
 * @param {string} languageScript A result of {@link scriptOfLanguage}.
 * @returns {boolean}
 */
export function scriptFits(textScript, languageScript) {
  if (textScript === languageScript) return true;
  const cjk = new Set(['Han', 'Japanese']);
  return cjk.has(textScript) && cjk.has(languageScript);
}

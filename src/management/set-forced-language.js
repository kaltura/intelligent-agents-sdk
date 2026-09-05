/**
 * setForcedLanguage: force an agent's reply language by writing the three
 * related fields together in one call. `force_language` alone does not change
 * the reply language; an explicit instruction in `base_directive` does.
 *
 *   1. `force_language` on the intellect config (display name, e.g. "Hebrew").
 *   2. `asr.language` on the agent, so speech RECOGNITION matches the language.
 *   3. A language instruction appended to `base_directive`, wrapped in a
 *      marker. This is what forces the reply language.
 *
 * WRITE, idempotent: the marker keys the instruction, so calling again with a
 * different language replaces the earlier instruction instead of stacking
 * another one. Pass `language: null` to remove the instruction and reset
 * `asr.language` to `'en'` and `force_language` to `''`.
 */
import { meta } from '../core/ids.js';
import { KalturaError } from '../core/errors.js';
import { requireInt } from './intellect-body.js';

const MARKER_START = '<!-- sdk:forced-language -->';
const MARKER_END = '<!-- /sdk:forced-language -->';
const MARKER_RE = /\s*<!-- sdk:forced-language -->[\s\S]*?<!-- \/sdk:forced-language -->/;

/**
 * ISO 639-1 code -> English display name, for the languages this helper can
 * name in the injected instruction without a caller-supplied override. Pass
 * `languageName` explicitly for any code not listed here.
 * @type {Readonly<Record<string,string>>}
 */
export const LANGUAGE_NAMES = Object.freeze({
  en: 'English', he: 'Hebrew', ar: 'Arabic', es: 'Spanish', fr: 'French',
  de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', hi: 'Hindi', nl: 'Dutch', pl: 'Polish',
  tr: 'Turkish', sv: 'Swedish', da: 'Danish', fi: 'Finnish', el: 'Greek',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', uk: 'Ukrainian', ro: 'Romanian',
  hu: 'Hungarian', cs: 'Czech', no: 'Norwegian',
});

/** @param {string} detail @param {string} [code] */
function bad(detail, code = 'bad_request') {
  return new KalturaError({ type: 'about:blank', title: code.replace(/_/g, ' '), code, detail });
}

/**
 * @param {import('./client.js').Management} mgmt
 * @param {object} opts
 * @param {number} opts.configId Intellect configId (the same one the target agent's `intellect.id` points at).
 * @param {string} opts.agentId
 * @param {string|null} opts.language ISO 639-1 code (e.g. `'he'`), or `null` to clear a previously-forced language.
 * @param {string} [opts.languageName] Display name used in `force_language` and the injected instruction (required if `language` isn't in {@link LANGUAGE_NAMES}; ignored when clearing).
 * @param {string} [opts.asrProvider] ASR provider passed through to `agents.update`. Defaults to `'kaltura'`.
 * @param {string} ks (admin)
 * @returns {Promise<{configId:number, agentId:string, language:string|null, languageName?:string, applied:{intellect:object, agent:object}, _meta:object}>}
 */
export async function setForcedLanguage(mgmt, opts, ks) {
  mgmt._ctx.assertAdmin(ks, 'setForcedLanguage');
  requireInt(opts && opts.configId, 'setForcedLanguage configId');
  const { configId, agentId } = opts;
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw bad('setForcedLanguage needs a non-empty opts.agentId string.');
  }
  const language = opts.language === null ? null : opts.language;
  if (language !== null && (typeof language !== 'string' || !language.trim())) {
    throw bad('setForcedLanguage needs opts.language as an ISO 639-1 code string, or null to clear.');
  }

  let languageName;
  if (language !== null) {
    languageName = opts.languageName || LANGUAGE_NAMES[language.toLowerCase()];
    if (!languageName) {
      throw bad(`setForcedLanguage: no display name known for language code "${language}". Pass opts.languageName explicitly (e.g. "Hebrew").`);
    }
  }
  const asrProvider = opts.asrProvider || 'kaltura';

  const intellectResult = await mgmt.intellectConfig.patch(configId, (cur) => {
    const currentDirective = typeof cur.base_directive === 'string' ? cur.base_directive : '';
    const stripped = currentDirective.replace(MARKER_RE, '').trimEnd();
    const base_directive = language === null
      ? stripped
      : `${stripped}${stripped ? '\n\n' : ''}${MARKER_START} Always respond in ${languageName}, regardless of what language the user writes or speaks in. ${MARKER_END}`;
    return { base_directive, force_language: language === null ? '' : languageName };
  }, ks);

  const agentResult = await mgmt.agents.update({
    agentId,
    asr: { language: language === null ? 'en' : language.toLowerCase(), provider: asrProvider },
  }, ks);

  return {
    configId,
    agentId,
    language,
    ...(languageName ? { languageName } : {}),
    applied: { intellect: intellectResult, agent: agentResult },
    _meta: meta({
      partnerId: mgmt._ctx.partnerId, source: 'sdk/setForcedLanguage',
      scope: `configId:${configId}, agentId:${agentId}`,
    }),
  };
}

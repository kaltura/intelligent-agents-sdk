/**
 * setForcedLanguage: force an agent's reply language by writing the two
 * related fields together in one call.
 *
 *   1. `force_language` on the intellect config (display name, e.g. "Hebrew").
 *      The backend enforces it at runtime: replies come back in that language
 *      no matter what language the user writes or speaks in.
 *   2. `asr.language` on the agent, so speech RECOGNITION matches the language.
 *
 * WRITE, idempotent. Pass `language: null` to clear `force_language` and reset
 * `asr.language` to `'en'`. Earlier SDK versions also appended a marker-wrapped
 * instruction to `base_directive`; every call strips that block if present, so
 * an intellect set up with an older SDK ends up with one clean directive.
 */
import { meta } from '../core/ids.js';
import { KalturaError } from '../core/errors.js';
import { requireInt } from './intellect-body.js';

const MARKER_RE = /\s*<!-- sdk:forced-language -->[\s\S]*?<!-- \/sdk:forced-language -->/g;

/**
 * ISO 639-1 code -> English display name for `force_language`. Pass
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
 * @param {string} [opts.languageName] Display name written to `force_language` (required if `language` isn't in {@link LANGUAGE_NAMES}; ignored when clearing).
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
  if (opts.language !== null && (typeof opts.language !== 'string' || !opts.language.trim())) {
    throw bad('setForcedLanguage needs opts.language as an ISO 639-1 code string, or null to clear.');
  }
  const language = opts.language === null ? null : opts.language.trim().toLowerCase();

  let languageName;
  if (language !== null) {
    const languageNameOverride = typeof opts.languageName === 'string' ? opts.languageName.trim() : '';
    languageName = languageNameOverride || LANGUAGE_NAMES[language];
    if (!languageName) {
      throw bad(`setForcedLanguage: no display name known for language code "${language}". Pass opts.languageName explicitly (e.g. "Hebrew").`);
    }
  }
  const asrProvider = opts.asrProvider || 'kaltura';

  const intellectResult = await mgmt.intellectConfig.patch(configId, (cur) => {
    const changes = { force_language: language === null ? null : languageName };
    const currentDirective = typeof cur.base_directive === 'string' ? cur.base_directive : '';
    if (currentDirective.includes('<!-- sdk:forced-language -->')) {
      changes.base_directive = currentDirective.replace(MARKER_RE, '').trimEnd();
    }
    return changes;
  }, ks);

  const agentResult = await mgmt.agents.update({
    agentId,
    asr: { language: language === null ? 'en' : language, provider: asrProvider },
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

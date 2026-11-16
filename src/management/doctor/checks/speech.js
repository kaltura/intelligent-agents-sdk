/**
 * Checks on text a voice will speak: the opening line and the prompt rules
 * that tell the model how to write for speech. Pure: they read the views
 * `gather.js` built. They say what the config makes likely, never what a
 * voice did, so each message says what to listen for.
 */
import { isSilentOpening, LEGACY_SILENT_OPENING, SILENT_OPENING } from '../../../core/opening.js';
import { normalizeLanguage, stripTemplateSyntax } from '../language.js';
import { forcedLanguage, voicesOf } from './agent.js';

/** @typedef {import('../model.js').AgentView} AgentView */
/** @typedef {import('../model.js').IntellectView} IntellectView */
/** @typedef {import('../model.js').DoctorCheck} DoctorCheck */
/** @typedef {import('../../audit-report.js').AuditFinding} AuditFinding */

/** Digits and symbols that a voice reads in its own language, or garbles. */
const DIGITS_OR_SYMBOLS = /[\d%$&€£#]/;

/** Number words that are normal English with a hyphen ("twenty-five"). */
const NUMBER_WORDS = new Set('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion'.split(' '));

/** Words that say the output is spoken. */
const SPOKEN_WORDS = /\b(spoken|speak|speaks|speaking|speech|aloud|text-to-speech|tts|voice|pron(?:ou|u)nc\w*)\b/i;

/** A spoken-forms row in a prompt: `Term -> "spoken form"`. Also `→`, `=>` and a leading bullet. */
const TABLE_ROW = /^[ \t]*(?:[-*][ \t]+)?(.{1,80}?)[ \t]*(?:->|→|=>)[ \t]*["“]([^"”\n]{1,80})["”][ \t\r]*$/gm;

/** A row with no quotes: `Term -> spoken form`. One short line, one arrow, no sentence end. */
const BARE_ROW = /^[ \t]*(?:[-*][ \t]+)?([^\s>→=][^>→=\n"“”]{0,39}?)[ \t]*(?:->|→|=>)[ \t]*([^\s"“”>→=-][^"“”>→=\n]{0,59}?)[ \t\r]*$/gm;

/** Bare rows count only as a table: fewer than this many lines is a stray arrow in prose. */
const MIN_BARE_ROWS = 3;

/** The intellect, unless it is external. @param {Record<string, any>|undefined} config */
const brainOf = (config) => (config && config.type !== 'external' ? config : null);

/** The base directive and the prompt blocks as one text. @param {Record<string, any>} config */
function promptText(config) {
  const blocks = (Array.isArray(config.prompts) ? config.prompts : []).map((/** @type {any} */ p) => p?.value);
  return [config.base_directive, ...blocks].filter((/** @type {unknown} */ s) => typeof s === 'string').join('\n');
}

/**
 * Every `Term -> "spoken"` row in the prompt text. Rows without quotes count when at least
 * three of them appear, so one arrow in a sentence is not read as a table.
 * @param {Record<string, any>} config @returns {Array<{term:string, spoken:string}>}
 */
export function spokenFormRows(config) {
  const text = promptText(config);
  const rows = [...text.matchAll(TABLE_ROW)].map((m) => ({ term: m[1].trim(), spoken: m[2].trim() }));
  const bare = [...text.matchAll(BARE_ROW)].map((m) => ({ term: m[1].trim(), spoken: m[2].trim() })).filter((r) => !/[.!?:;]$/.test(r.spoken));
  const all = bare.length >= MIN_BARE_ROWS ? [...rows, ...bare] : rows;
  return all.filter((r, i) => all.findIndex((o) => o.term === r.term && o.spoken === r.spoken) === i);
}

/** True when a spoken form is written to be read letter by letter or syllable by syllable. @param {string} spoken */
function oddRespelling(spoken) {
  return spoken.split(/\s+/).some((word) => {
    if (word.includes('-') && !word.split('-').every((part) => NUMBER_WORDS.has(part.toLowerCase()))) return true;
    return /[a-z][A-Z]/.test(word) || (/[A-Z]{2,}/.test(word) && /[a-z]/.test(word));
  });
}

/** A short list for a message. @param {string[]} items @param {boolean} [quote] Wrap each item in double quotes. */
const list = (items, quote = true) => `${items.slice(0, 5).map((s) => (quote ? `"${s}"` : s)).join(', ')}${items.length > 5 ? `, and ${items.length - 5} more` : ''}`;

/** A spoken agent whose prompt never says the output is spoken. @type {DoctorCheck} */
export const spokenOutputUndeclared = {
  id: 'spoken-output-undeclared', category: 'speech', scope: 'intellect', needs: ['intellect', 'avatars'], codes: ['spoken_output_undeclared'],
  run(/** @type {IntellectView} */ iv) {
    const c = brainOf(iv.config);
    if (!c || !iv.agents.some((a) => a.avatars.length > 0)) return [];
    const forced = normalizeLanguage(c.force_language);
    const prose = stripTemplateSyntax(promptText(c));
    if (prose.trim().length < 200 || SPOKEN_WORDS.test(prose) || (forced !== null && forced !== 'en')) return [];
    return [{
      severity: 'info', code: 'spoken_output_undeclared', field: 'prompts', configId: iv.configId, agentIds: iv.agentIds,
      message: 'The agent has an avatar, but no prompt says the reply is spoken aloud. The model then writes for the screen: digits, symbols, abbreviations and markdown that a voice reads badly. If the prompt says it in another word or language, ignore this.',
      fix: 'Add a rule that the output is read by a text-to-speech voice, and say how to write numbers, symbols and abbreviations. Put it early and repeat it near the end of a long prompt.',
    }];
  },
};

/** Respellings written with hyphens or mixed case. @type {DoctorCheck} */
export const respellingStyle = {
  id: 'respelling-style', category: 'speech', scope: 'intellect', needs: ['intellect'], codes: ['respelling_hyphen_or_mixed_case'],
  run(/** @type {IntellectView} */ iv) {
    const c = brainOf(iv.config);
    if (!c) return [];
    const odd = spokenFormRows(c).filter((r) => oddRespelling(r.spoken));
    if (odd.length === 0) return [];
    return [{
      severity: 'info', code: 'respelling_hyphen_or_mixed_case', field: 'prompts', configId: iv.configId, agentIds: iv.agentIds,
      message: `${odd.length} spoken form(s) use hyphens or mixed case: ${list(odd.map((r) => r.spoken))}. In listening tests, voices often spelled these letter by letter or stuttered on them.`,
      fix: 'Write each spoken form as plain lowercase words with no hyphens ("kay ger", not "KAY-ger"), then listen to it on the voice you use. A form that works on one voice can fail on another.',
    }];
  },
};

/** Digits or symbols that a voice for another language will not read as the reply language. @type {DoctorCheck} */
export const spokenDigitsCrossLanguage = {
  id: 'spoken-digits-cross-language', category: 'speech', scope: 'agent', needs: ['intellect', 'catalog'], codes: ['spoken_text_digits_cross_language'],
  run(/** @type {AgentView} */ view) {
    const c = brainOf(view.intellect);
    if (!c) return [];
    const reply = forcedLanguage(view) ?? normalizeLanguage(view.agent.asr?.language);
    if (reply === null) return [];
    const voice = voicesOf(view).find((v) => v.language !== null && v.language !== reply);
    if (!voice) return [];
    /** @type {Array<{where:string, text:string}>} */
    const spoken = spokenFormRows(c).map((r) => ({ where: `prompt row "${r.term}"`, text: r.spoken }));
    // The intellect's opening line is the one spoken. Without it, each avatar's own line is.
    const lines = typeof c.opening_phrase === 'string' && c.opening_phrase.trim() !== ''
      ? [{ where: 'opening_phrase', line: c.opening_phrase }]
      : view.avatars.map((a) => ({ where: `avatar ${a.id} openingPhrase`, line: a.avatar?.openingPhrase }));
    for (const { where, line } of lines) {
      if (typeof line === 'string' && line.trim() !== '' && !isSilentOpening(line)) spoken.push({ where, text: stripTemplateSyntax(line) });
    }
    const hits = spoken.filter((s) => DIGITS_OR_SYMBOLS.test(s.text));
    if (hits.length === 0) return [];
    return [{
      severity: 'warn', code: 'spoken_text_digits_cross_language', agentId: view.agentId, ...(view.configId !== undefined ? { configId: view.configId } : {}),
      field: hits[0].where,
      message: `Voice "${voice.name}"${voice.provider ? ` (${voice.provider})` : ''} is made for "${voice.language}", but replies are in "${reply}". Digits and symbols in text it speaks are read in "${voice.language}" or garbled. Found in: ${list(hits.map((h) => h.where), false)}.`,
      fix: 'Write numbers and symbols as words in the reply language ("twelve percent", "the third quarter", "R and D"), then listen on this voice. For a voice made for the reply language, add { code: \'spoken_text_digits_cross_language\', agentId: \'' + view.agentId + '\' } to the ignore list.',
    }];
  },
};

/** One spoken-forms table on voices from different providers. @type {DoctorCheck} */
export const respellingTableSharedProviders = {
  id: 'respelling-table-shared-providers', category: 'speech', scope: 'intellect', needs: ['intellect', 'catalog'], codes: ['respelling_table_shared_across_providers'],
  run(/** @type {IntellectView} */ iv) {
    const c = brainOf(iv.config);
    if (!c || spokenFormRows(c).length === 0) return [];
    const providers = [...new Set(iv.agents.flatMap((a) => voicesOf(a).map((v) => v.provider)).filter((/** @type {string|null} */ p) => p !== null))].sort();
    if (providers.length < 2) return [];
    return [{
      severity: 'info', code: 'respelling_table_shared_across_providers', field: 'prompts', configId: iv.configId, agentIds: iv.agentIds,
      message: `One spoken-forms table is used by agents whose voices come from different providers: ${providers.join(', ')}. In listening tests the same respelling won on one provider and failed on another.`,
      fix: 'Give each provider its own intellect and table, and listen to every row on the voice that will speak it. If the voices are known to read the table the same way, ignore this.',
    }];
  },
};

/** A silent phrase alone as a `{% if %}`, `{% elif %}` or `{% else %}` branch of a template. A condition may contain `%`. */
const SILENT_BRANCH = /\{%-?\s*(?:if|elif|else)\b(?:[^%]|%(?!\}))*?-?%\}\s*(-|<blank>)\s*(?=\{%)/g;
const IF_TAG = /\{%-?\s*if\b/g;

/**
 * The silent phrases an opening line can render: the whole line, or one branch of a template
 * that is a single `{% if %}` from start to end. A dash inside a sentence is not one.
 * @param {unknown} line @returns {string[]}
 */
function silentPhrasesIn(line) {
  if (typeof line !== 'string') return [];
  const text = line.trim();
  const wrapped = /^\{%-?\s*if\b/.test(text) && /\{%-?\s*endif\s*-?%\}$/.test(text) && (text.match(IF_TAG) || []).length === 1;
  const phrases = isSilentOpening(text) ? [text] : wrapped ? [...text.matchAll(SILENT_BRANCH)].map((m) => m[1]) : [];
  return [...new Set(phrases)];
}

/**
 * Silent openings, against the voice provider. The line that is spoken is the intellect's `opening_phrase`,
 * or each avatar's `openingPhrase` when the intellect has none. An avatar line is checked against that avatar's voice.
 * @type {DoctorCheck}
 */
export const silentOpeningVoice = {
  id: 'silent-opening-voice', category: 'speech', scope: 'agent', needs: ['intellect', 'avatars', 'catalog'], codes: ['silent_opening_unsupported_voice', 'silent_opening_legacy_phrase'],
  run(/** @type {AgentView} */ view) {
    const c = brainOf(view.intellect);
    /** @type {{where:string, line:unknown, avatarId?:string}[]} */
    const lines = typeof c?.opening_phrase === 'string' && c.opening_phrase.trim() !== ''
      ? [{ where: 'opening_phrase', line: c.opening_phrase }]
      : view.avatars.map((a) => ({ where: `avatar ${a.id} openingPhrase`, line: a.avatar?.openingPhrase, avatarId: a.id }));
    const silent = lines.map((l) => ({ ...l, phrases: silentPhrasesIn(l.line) })).filter((l) => l.phrases.length > 0);
    if (silent.length === 0) return [];
    const voices = voicesOf(view);
    const base = { agentId: view.agentId, ...(view.configId !== undefined ? { configId: view.configId } : {}) };
    /** The call that rewrites one line. @param {{avatarId?:string}} l @param {string} expr A JS expression for the new text. */
    const write = (l, expr) => l.avatarId !== undefined
      ? `await mgmt.avatars.update({ id: '${l.avatarId}', openingPhrase: ${expr} }, adminKs)`
      : `await mgmt.intellectConfig.setOpeningPhrase(${view.configId ?? 'configId'}, ${expr}, adminKs)`;
    for (const l of silent) {
      const voice = voices.find((v) => v.provider === 'cartesia' && (l.avatarId === undefined || v.avatarId === l.avatarId));
      if (!voice) continue;
      return [{
        ...base, field: l.where, severity: 'error', code: 'silent_opening_unsupported_voice',
        message: `The opening line is silent and voice "${voice.name}" is a Cartesia voice. In our measurements the opening turn of a Cartesia voice did not end, so every speak() and the kickoff stay held and get no reply.`,
        fix: `Write a spoken opening line: ${write(l, "'Hi.'")}. Or give the avatar an ElevenLabs voice with mgmt.avatars.update. Then connect once and check that the agent answers.`,
      }];
    }
    const legacy = silent.find((l) => l.phrases.includes(LEGACY_SILENT_OPENING));
    if (!legacy) return [];
    return [{
      ...base, field: legacy.where, severity: 'warn', code: 'silent_opening_legacy_phrase',
      message: `The opening line uses ${LEGACY_SILENT_OPENING}. On ElevenLabs voices the opening turn with it does not end, so every speak() and the kickoff stay held and get no reply.`,
      fix: `Replace ${LEGACY_SILENT_OPENING} with ${SILENT_OPENING} (SILENT_OPENING): ${write(legacy, 'SILENT_OPENING')}. In a template, change the branch text instead.`,
    }];
  },
};

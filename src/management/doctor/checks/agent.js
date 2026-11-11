/**
 * Checks on an agent, its avatars and their voices. Pure: they read the views
 * `gather.js` built and return findings. Language checks compare values only.
 * The SDK knows no list of supported languages, so an unrecognized value is
 * skipped, never reported.
 */
import { isSilentOpening } from '../../../core/opening.js';
import { dominantScript, normalizeLanguage, sameLanguage, scriptFits, scriptOfLanguage } from '../language.js';

/** @typedef {import('../model.js').AgentView} AgentView */
/** @typedef {import('../model.js').DoctorCheck} DoctorCheck */
/** @typedef {import('../../audit-report.js').AuditFinding} AuditFinding */

/** @param {unknown} v @returns {v is string} */
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** The intellect, unless it is external (an external intellect has no brain config). @param {AgentView} view */
const brain = (view) => (view.intellect && view.intellect.type !== 'external' ? view.intellect : null);

/** The language the agent is told to reply in, as a code, or `null`. @param {AgentView} view */
const forcedLanguage = (view) => normalizeLanguage(brain(view)?.force_language);

/**
 * The voices of an agent's found avatars, with their language.
 * @param {AgentView} view
 * @returns {Array<{avatarId:string, voiceId:string, name:string, custom:boolean, raw:unknown, language:string|null}>}
 */
function voicesOf(view) {
  return view.avatars.flatMap((a) => (a.voice?.state === 'found' && a.voice.item
    ? [{
      avatarId: a.id, voiceId: a.voice.id, name: String(a.voice.item.name ?? a.voice.id),
      custom: Array.isArray(a.voice.item.adminTags) && a.voice.item.adminTags.includes('custom'),
      raw: a.voice.item.language, language: normalizeLanguage(a.voice.item.language),
    }]
    : []));
}

/** @param {AgentView} view @param {string} language The `agents.update` call that sets the recognition language. */
const setAsrFix = (view, language) => `await mgmt.agents.update({ agentId: '${view.agentId}', asr: { language: '${language}', provider: '${view.agent.asr?.provider ?? 'kaltura'}' } }, adminKs)`;

/**
 * @param {AuditFinding['severity']} severity @param {string} code @param {AgentView} view
 * @param {Partial<AuditFinding> & {message:string, fix:string}} rest
 * @returns {AuditFinding}
 */
const found = (severity, code, view, rest) => ({ severity, code, agentId: view.agentId, ...(view.configId !== undefined ? { configId: view.configId } : {}), ...rest });

/** Speech recognition language against the language replies are forced to, then against the voice. @type {DoctorCheck} */
export const asrLanguage = {
  id: 'asr-language', category: 'language', scope: 'agent', needs: ['intellect', 'catalog'], codes: ['asr_language_mismatch'],
  run(/** @type {AgentView} */ view) {
    const asr = view.agent.asr?.language;
    if (normalizeLanguage(asr) === null) return [];
    const forced = forcedLanguage(view);
    if (forced) {
      if (sameLanguage(asr, forced) !== false) return [];
      return [found('error', 'asr_language_mismatch', view, {
        field: 'asr.language',
        message: `asr.language is "${asr}", but the intellect forces replies in "${brain(view)?.force_language}". Speech in that language is recognized as "${asr}".`,
        fix: `Set the recognition language to match: ${setAsrFix(view, forced)}`,
      })];
    }
    const other = voicesOf(view).find((v) => v.language !== null && v.language !== normalizeLanguage(asr));
    if (!other?.language) return [];
    return [found('warn', 'asr_language_mismatch', view, {
      field: 'asr.language',
      message: `asr.language is "${asr}", but voice "${other.name}" is made for "${other.language}". If callers speak "${other.language}", they are recognized as "${asr}".`,
      fix: `If callers speak "${other.language}": ${setAsrFix(view, other.language)}. If this is intended, add { code: 'asr_language_mismatch', agentId: '${view.agentId}' } to the ignore list.`,
    })];
  },
};

/** A custom voice that kept the default language `en`. @type {DoctorCheck} */
export const voiceLanguageDefault = {
  id: 'voice-language-default', category: 'language', scope: 'agent', needs: ['intellect', 'catalog'], codes: ['voice_language_default'],
  run(/** @type {AgentView} */ view) {
    const target = forcedLanguage(view) ?? normalizeLanguage(view.agent.asr?.language);
    if (!target || target === 'en') return [];
    return voicesOf(view).filter((v) => v.custom && v.language === 'en').map((v) => found('info', 'voice_language_default', view, {
      field: `avatar ${v.avatarId} voice`,
      message: `Custom voice "${v.name}" has the default language "en", but the agent works in "${target}". A voice upload without a language gets "en".`,
      fix: `Upload the sample again with the language: mgmt.catalog.createVoice(file, { name, description, language: '${target}' }, adminKs). Then point the avatar at the new voice.`,
    }));
  },
};

/** A voice that is not made for the language replies are forced to. @type {DoctorCheck} */
export const voiceReplyLanguage = {
  id: 'voice-reply-language', category: 'language', scope: 'agent', needs: ['intellect', 'catalog'], codes: ['voice_reply_language_mismatch'],
  run(/** @type {AgentView} */ view) {
    const forced = forcedLanguage(view);
    if (!forced) return [];
    return voicesOf(view).filter((v) => v.language !== null && v.language !== forced).map((v) => found('error', 'voice_reply_language_mismatch', view, {
      field: `avatar ${v.avatarId} voice`,
      message: `Replies are forced to "${forced}", but voice "${v.name}" is made for "${v.language}". The voice speaks, but the audio is not intelligible "${forced}". No runtime event shows this.`,
      fix: `Pick a voice made for "${forced}" (mgmt.catalog.list(adminKs, { type: 'Voice', filter: { languageEqual: '${forced}' } })) and set it on avatar ${v.avatarId} with mgmt.avatars.update. For a bilingual voice, add { code: 'voice_reply_language_mismatch', agentId: '${view.agentId}' } to the ignore list.`,
    }));
  },
};

/** An agent whose intellect does not exist. @type {DoctorCheck} */
export const intellectReference = {
  id: 'intellect-reference', category: 'agent', scope: 'agent', needs: ['intellect'], codes: ['intellect_not_found'],
  run(/** @type {AgentView} */ view) {
    if (view.intellectState !== 'missing') return [];
    return [found('error', 'intellect_not_found', view, {
      message: `Agent ${view.agentId} points at intellect ${view.configId}, which does not exist.`,
      fix: 'Point the agent at an existing intellect.',
    })];
  },
};

/** Avatars the agent lists, and the voice and visual each one uses. @type {DoctorCheck} */
export const avatarReferences = {
  id: 'avatar-references', category: 'avatar', scope: 'agent', needs: ['avatars', 'catalog'], codes: ['avatar_not_found', 'voice_not_in_catalog', 'visual_not_in_catalog'],
  run(/** @type {AgentView} */ view) {
    /** @type {AuditFinding[]} */
    const out = [];
    for (const a of view.avatars) {
      if (a.state === 'missing') {
        out.push(found('error', 'avatar_not_found', view, {
          field: 'avatarIds', message: `Agent ${view.agentId} lists avatar ${a.id}, which does not exist.`,
          fix: 'Remove it from the agent with mgmt.agents.update, or recreate the avatar.',
        }));
        continue;
      }
      if (a.voice?.state === 'missing') {
        out.push(found('warn', 'voice_not_in_catalog', view, {
          field: `avatar ${a.id} voice`,
          message: `Avatar ${a.id} uses voice ${a.voice.id}, which is not in the catalog. A raw provider voice id can be valid, so check with a live turn if unsure.`,
          fix: `Pick a voice from mgmt.catalog.list(adminKs, { type: 'Voice' }) and set it on the avatar with mgmt.avatars.update.`,
        }));
      }
      if (a.visual?.state === 'missing') {
        out.push(found('warn', 'visual_not_in_catalog', view, {
          field: `avatar ${a.id} visual`,
          message: `Avatar ${a.id} uses visual ${a.visual.id}, which is not in the catalog. It was probably deleted after the avatar was saved.`,
          fix: `Pick a visual from mgmt.catalog.list(adminKs, { type: 'Visual' }) and set it on the avatar with mgmt.avatars.update.`,
        }));
      }
    }
    return out;
  },
};

/** The opening line set on both the avatar and the intellect. @type {DoctorCheck} */
export const openingPhraseDuplicate = {
  id: 'opening-phrase-duplicate', category: 'avatar', scope: 'agent', needs: ['intellect', 'avatars'], codes: ['opening_phrase_duplicate'],
  run(/** @type {AgentView} */ view) {
    const live = brain(view)?.opening_phrase;
    if (!text(live)) return [];
    return view.avatars.filter((a) => text(a.avatar?.openingPhrase)).map((a) => found('info', 'opening_phrase_duplicate', view, {
      field: `avatar ${a.id} openingPhrase`,
      message: `Avatar ${a.id} and the intellect both set an opening line. The intellect's line is the one spoken.`,
      fix: `Remove the avatar copy: await mgmt.avatars.update({ id: '${a.id}', openingPhrase: null }, adminKs)`,
    }));
  },
};

/** An opening line in another script than the voice speaks. @type {DoctorCheck} */
export const openingPhraseLanguage = {
  id: 'opening-phrase-language', category: 'language', scope: 'agent', needs: ['intellect', 'catalog'], codes: ['opening_phrase_language_mismatch'],
  run(/** @type {AgentView} */ view) {
    if (!brain(view)) return [];
    const intellectLine = brain(view)?.opening_phrase;
    /** @type {AuditFinding[]} */
    const out = [];
    for (const a of view.avatars) {
      const line = text(intellectLine) ? intellectLine : a.avatar?.openingPhrase;
      if (!text(line) || isSilentOpening(line)) continue;
      const voiceScript = scriptOfLanguage(a.voice?.item?.language);
      const lineScript = dominantScript(line);
      if (!voiceScript || !lineScript || scriptFits(lineScript, voiceScript)) continue;
      out.push(found('info', 'opening_phrase_language_mismatch', view, {
        field: text(intellectLine) ? 'opening_phrase' : `avatar ${a.id} openingPhrase`,
        message: `The opening line is written in ${lineScript}, but the voice "${a.voice?.item?.name ?? a.voice?.id}" speaks "${normalizeLanguage(a.voice?.item?.language)}" (${voiceScript}).`,
        fix: 'Write the opening line in the voice language, or pick a voice made for the line.',
      }));
    }
    return out;
  },
};

/** A limit on the conversation that is shorter than a typical exchange. @type {DoctorCheck} */
export const maxConversation = {
  id: 'max-conversation', category: 'agent', scope: 'agent', needs: [], codes: ['max_conversation_short'],
  run(/** @type {AgentView} */ view, thresholds) {
    const seconds = view.agent.maxConversationLength;
    if (typeof seconds !== 'number' || seconds >= thresholds.minConversationSeconds) return [];
    return [found('info', 'max_conversation_short', view, {
      field: 'maxConversationLength',
      message: `maxConversationLength is ${seconds} s. The conversation ends after ${seconds} s, which cuts off most exchanges.`,
      fix: `Raise it (1 to 3600 s) with mgmt.agents.update, or ignore this if the limit is intended.`,
    })];
  },
};

/** An intellect that stores `avatar: 'disabled'` under an agent that has avatars. @type {DoctorCheck} */
export const avatarCapability = {
  id: 'avatar-capability', category: 'avatar', scope: 'agent', needs: ['intellect'], codes: ['capability_disabled_vetoes_avatar'],
  run(/** @type {AgentView} */ view) {
    const avatarIds = view.agent.avatarIds;
    if (!Array.isArray(avatarIds) || avatarIds.length === 0) return [];
    if (brain(view)?.capabilities?.avatar !== 'disabled') return [];
    return [found('error', 'capability_disabled_vetoes_avatar', view, {
      field: 'capabilities.avatar',
      message: `The intellect stores capabilities.avatar as "disabled", but agent ${view.agentId} has avatars. A stored "disabled" beats a per-request "on", so the avatar stays off. The stored map is not always reliable, so confirm with one live turn.`,
      fix: `Turn it on: await mgmt.intellectConfig.setCapability(${view.configId}, 'avatar', 'on', adminKs)`,
    })];
  },
};

/** An avatar used by more than one agent. @type {DoctorCheck} */
export const avatarShared = {
  id: 'avatar-shared', category: 'avatar', scope: 'partner', needs: [], codes: ['avatar_shared'],
  run(/** @type {{agents:AgentView[], selected:Set<string>}} */ { agents, selected }) {
    /** @type {Map<string, string[]>} */
    const users = new Map();
    for (const a of agents) for (const id of new Set(Array.isArray(a.agent.avatarIds) ? a.agent.avatarIds : [])) users.set(id, [...(users.get(id) ?? []), a.agentId]);
    return [...users].filter(([, ids]) => ids.length > 1 && ids.some((id) => selected.has(id))).map(([avatarId, ids]) => ({
      severity: /** @type {const} */ ('info'), code: 'avatar_shared', agentIds: ids.sort(), field: `avatar ${avatarId}`,
      message: `Avatar ${avatarId} is used by ${ids.length} agents: ${ids.join(', ')}. A change to it changes all of them.`,
      fix: 'Nothing to fix if the sharing is intended. To split them, create a second avatar for one agent.',
    }));
  },
};

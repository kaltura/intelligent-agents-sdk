/**
 * The silent opening phrase.
 *
 * The intellect's `opening_phrase` owns the scripted first turn of an avatar
 * session (`provision()` writes it there and leaves the avatar's `openingPhrase`
 * unset). That server-scripted opening turn cannot be interrupted. `SILENT_OPENING`
 * is a one-character phrase that ElevenLabs voices render as silence: the opening turn
 * still runs and the session stays on the normal path, but nothing is spoken, so the
 * turn ends in well under a second and the agent is ready for input almost immediately.
 * On other voice providers the opening turn may never end. The doctor flags that
 * (`silent_opening_unsupported_voice`).
 *
 * The raw phrase is a control token, not something to show a person. The session
 * classes surface the opening turn as `SILENT_OPENING_LABEL` (`[silence]`) on
 * `transcript`, `speechChunk` and `avatarStopTalking`, the same marker captions use
 * for a silent stretch, so a UI can render it as-is.
 *
 * Pair it with a client `kickoff` (see the session classes) to have the agent
 * start the conversation with an interruptible, prompt-driven greeting instead
 * of a fixed scripted line.
 */
import { KalturaError } from './errors.js';

/** The phrase that makes the opening turn silent. Write it to the intellect's `opening_phrase`. */
export const SILENT_OPENING = '-';

/** The phrase older SDK versions wrote. Still labeled `[silence]`, but the opening turn may never end. */
export const LEGACY_SILENT_OPENING = '<blank>';

/** What a UI shows for the silent opening turn. */
export const SILENT_OPENING_LABEL = '[silence]';

/**
 * True when `text` is the silent opening phrase, or the legacy one (ignoring surrounding whitespace).
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSilentOpening(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t === SILENT_OPENING || t === LEGACY_SILENT_OPENING;
}

/**
 * Validate and normalize a session's `cfg.kickoff` at construction. Pure: no network.
 * `'text'` and `{ text, echo? }` are accepted; empty/whitespace text means "no kickoff".
 * @param {unknown} kickoff
 * @param {string} where  Class name for the error message.
 * @returns {{text:string, echo:boolean}|null}
 * @throws {KalturaError} `bad_request` when the shape is wrong.
 */
export function normalizeKickoff(kickoff, where) {
  if (kickoff === undefined || kickoff === null) return null;
  const bad = (got) => new KalturaError({
    type: 'about:blank', title: 'bad kickoff', code: 'bad_request',
    detail: `${where}: cfg.kickoff must be a string or { text: string, echo?: boolean } (got ${got}).`,
  });
  let text; let echo = false;
  if (typeof kickoff === 'string') text = kickoff;
  else if (typeof kickoff === 'object' && !Array.isArray(kickoff)) {
    const o = /** @type {{text?: unknown, echo?: unknown}} */ (kickoff);
    if (typeof o.text !== 'string') throw bad(`text: ${typeof o.text}`);
    if (o.echo !== undefined && typeof o.echo !== 'boolean') throw bad(`echo: ${typeof o.echo}`);
    text = o.text; echo = o.echo === true;
  } else throw bad(Array.isArray(kickoff) ? 'array' : typeof kickoff);
  return text.trim() ? { text, echo } : null;
}

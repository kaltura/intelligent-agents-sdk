/**
 * The silent opening phrase.
 *
 * An avatar's `openingPhrase` must be a non-empty string, and the server-scripted
 * opening turn it produces cannot be interrupted. `SILENT_OPENING` is the SSML
 * silence tag: non-empty, so the opening turn still runs and the session stays on
 * the normal path, but the TTS speaks nothing for it, so the turn ends in well
 * under a second and the agent is ready for input almost immediately.
 *
 * Pair it with a client `kickoff` (see the session classes) to have the agent
 * start the conversation with an interruptible, prompt-driven greeting instead
 * of a fixed scripted line.
 */
export const SILENT_OPENING = '<blank>';

/**
 * True when `text` is the silent opening phrase (ignoring surrounding whitespace).
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSilentOpening(text) {
  return typeof text === 'string' && text.trim() === SILENT_OPENING;
}

/**
 * Shared subscription tracker for the "subscribe to another Emitter, clean up on my own
 * destroy/stop" pattern — used by any class that listens on a `KalturaAvatarSession` (or
 * any other `Emitter`) and must remove those listeners on teardown. Replaces three
 * independently hand-rolled versions of the same idea (an `_unsubs` array in `presenter.js`
 * and `genui/renderer.js`, a parallel bound-handler-plus-`off()` pair in `captions.js`) with
 * one implementation, so the pattern can't drift out of sync between call sites again.
 */
export class Teardown {
  constructor() { /** @type {Array<() => void>} */ this._unsubs = []; }

  /** Track an unsubscribe closure (e.g. the return value of `emitter.on(...)`). Returns it unchanged, so a call can stay inline. @param {() => void} unsub @returns {() => void} */
  track(unsub) { this._unsubs.push(unsub); return unsub; }

  /** Run every tracked unsubscribe closure and clear the list. Idempotent — safe to call more than once. */
  run() { for (const off of this._unsubs.splice(0)) { try { off(); } catch { /* */ } } }
}

/**
 * Tiny event emitter — zero-dep, isomorphic (no Node `events` import, so the
 * same file runs in the browser). The Experience session extends this to expose
 * its typed event surface (`on`/`off`/`once`). A throwing listener never breaks
 * the emit loop and never crashes the session.
 */
export class Emitter {
  constructor() { /** @type {Map<string, Set<Function>>} */ this._listeners = new Map(); }

  /** @param {string} event @param {Function} fn @returns {() => void} unsubscribe */
  on(event, fn) {
    let set = this._listeners.get(event);
    if (!set) this._listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** @param {string} event @param {Function} fn */
  off(event, fn) { this._listeners.get(event)?.delete(fn); }

  /** @param {string} event @param {Function} fn */
  once(event, fn) {
    const wrap = (/** @type {any[]} */ ...args) => { this.off(event, wrap); fn(...args); };
    return this.on(event, wrap);
  }

  /** @param {string} event @param {...any} args */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { this._onListenerError(event, err); }
    }
  }

  /** Overridable hook so a stray listener throw is observable, never fatal. */
  _onListenerError(event, err) {
    if (event !== 'error') this.emit('error', err);
  }

  removeAllListeners() { this._listeners.clear(); }
}

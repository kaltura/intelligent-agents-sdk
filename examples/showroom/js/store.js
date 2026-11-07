/**
 * A tiny store. State lives in the closure, never at module level.
 * @template S, A
 * @param {(s:S,a:A)=>S} reducer
 * @param {S} initial
 */
export function createStore(reducer, initial) {
  let state = initial;
  /** @type {Set<(next:S,prev:S,action:A)=>void>} */
  const listeners = new Set();
  return {
    getState: () => state,
    /** @param {A} action @returns {S} */
    dispatch(action) {
      const prev = state;
      const next = reducer(prev, action);
      if (next === prev) return prev;
      state = next;
      for (const fn of [...listeners]) fn(next, prev, action);
      return next;
    },
    /** @param {(next:S,prev:S,action:A)=>void} fn @returns {()=>void} unsubscribe */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

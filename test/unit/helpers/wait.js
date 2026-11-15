/**
 * Wait helpers for the fake handshake. The handshake is a chain of macrotask hops, so a fixed
 * `setTimeout` can fire before it ends on a loaded machine. Wait for the real event or condition.
 */

/** Poll `cond()` on macrotasks until it is truthy. Rejects after `ms`. */
export async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until(): condition not met in time');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Resolves once both tracks reached the session, or when `connectP` settles first (a rejecting connect() ends the wait). Call right after `connect()`. */
export function bothTracks(session, connectP) {
  let tracks = 0;
  const arrived = new Promise((resolve) => session.on('track', () => { if (++tracks === 2) resolve(); }));
  return Promise.race([arrived, connectP]);
}

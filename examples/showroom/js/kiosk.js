/**
 * Kiosk behavior for a shared, human-scale screen: after a quiet period, show
 * a warning, then reset the cart and return to the welcome screen so the next
 * visitor starts clean. `onReset` runs first, so the app can end the conversation too. Any touch or key
 * counts as activity, and `poke()` counts anything else, such as speech.
 */
export function createKiosk({ store, onWarn = () => {}, onReset = () => {}, idleMs = 90_000, warnMs = 15_000 }) {
  let idleTimer = 0;
  let warnTimer = 0;
  let warned = false;

  function arm() {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    if (warned) { warned = false; onWarn(false); }
    if (store.getState().scene === 'welcome' && store.getState().history.length === 0) return;
    idleTimer = setTimeout(() => {
      warned = true;
      onWarn(true);
      warnTimer = setTimeout(() => { warned = false; onWarn(false); onReset(); store.dispatch({ type: 'reset' }); }, warnMs);
    }, idleMs);
  }
  const events = ['pointerdown', 'keydown', 'touchstart'];
  for (const e of events) addEventListener(e, arm, { passive: true });
  const off = store.subscribe(arm);
  arm();
  return {
    /** Count something other than input as activity, such as the customer speaking. */
    poke: arm,
    destroy() { clearTimeout(idleTimer); clearTimeout(warnTimer); off(); for (const e of events) removeEventListener(e, arm); },
  };
}

/**
 * Session-completion signal — POST `{genieUrl}{path}` (`{id: threadId}`,
 * `Authorization: KS <token>`) the moment a conversation is genuinely over, so
 * backend lifecycle rules (summaries, insights, CRM pushes) fire in seconds
 * instead of waiting for the ~10-minute idle scanner.
 *
 * Zero deps, no `window`/`globalThis` writes (Constitution I-2) — every
 * listener this module adds is handed back through `unwire()` via the shared
 * `Teardown` helper (I-4). One `sent` flag makes every path idempotent
 * regardless of how it's reached (D-4).
 */
import { Teardown } from './teardown.js';

// Reasons reached from a page-lifecycle event: the page may die at any moment,
// so these never get an abort timeout — the unload path must not await anything.
const UNLOAD_REASONS = new Set(['pagehide', 'pagehide_bfcache', 'hidden_grace']);

/**
 * @param {object} opts
 * @param {typeof fetch} opts.fetch
 * @param {string} opts.genieUrl
 * @param {string} opts.path
 * @param {() => string|null} opts.getToken
 * @param {(type:string, outcome:string, fields?:object) => void} opts.audit
 * @param {(event:string, payload:object) => void} opts.emit
 * @param {(level:string, msg:string, data?:unknown) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {boolean} opts.enabled
 * @param {number} opts.timeoutMs
 * @param {boolean} opts.pageLifecycleAware
 * @param {number} opts.hiddenGraceMs
 * @param {boolean} opts.completeOnHiddenGrace
 * @param {boolean} opts.completeOnBfcache
 * @param {boolean} opts.crossTabPresence
 * @param {string} opts.presenceChannelPrefix
 * @param {number} opts.presenceHeartbeatMs
 * @param {number} opts.presenceStaleMs
 * @returns {{noteThreadId:(id:string)=>void, wire:()=>void, unwire:()=>void, touch:()=>void, finalize:(reason:string)=>Promise<object>, complete:(reason?:string)=>Promise<object>}}
 */
export function createSessionCompleter(opts) {
  const {
    fetch: fetchImpl, genieUrl, path, getToken, audit, emit, log = () => {}, now = () => Date.now(),
    enabled, timeoutMs,
    pageLifecycleAware, hiddenGraceMs, completeOnHiddenGrace, completeOnBfcache,
    crossTabPresence, presenceChannelPrefix, presenceHeartbeatMs, presenceStaleMs,
  } = opts;

  let threadId = null;
  let sent = false;
  let wired = false;
  const teardown = new Teardown();
  let hiddenTimer = null;
  let channel = null;
  let instanceId = null;
  /** @type {Map<string, number>} peer instance id -> last-seen ms */
  const peers = new Map();

  function clearHiddenTimer() { if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; } }

  function prunePeers() {
    const cutoff = now() - presenceStaleMs;
    for (const [id, seen] of peers) if (seen < cutoff) peers.delete(id);
  }

  function post(t) { try { channel?.postMessage({ v: 1, id: instanceId, t }); } catch { /* a dying channel must never throw into the caller */ } }

  /** Open the presence channel the first time a real threadId lands — never at construction (I-2/D-4: nothing thread-keyed until then). */
  function openPresence() {
    if (!crossTabPresence || channel || typeof BroadcastChannel !== 'function' || !threadId) return;
    instanceId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    try { channel = new BroadcastChannel(`${presenceChannelPrefix}:${threadId}`); }
    catch { channel = null; return; }
    const onMessage = (ev) => {
      const msg = ev?.data;
      if (!msg || msg.id === instanceId) return;
      if (msg.t === 'hello') { peers.set(msg.id, now()); post('ack'); }
      else if (msg.t === 'ack' || msg.t === 'alive') peers.set(msg.id, now());
      else if (msg.t === 'bye') peers.delete(msg.id);
    };
    channel.addEventListener('message', onMessage);
    teardown.track(() => { try { channel?.removeEventListener('message', onMessage); } catch { /* */ } });
    post('hello');
    const heartbeat = setInterval(() => post('alive'), presenceHeartbeatMs);
    heartbeat.unref?.();
    teardown.track(() => clearInterval(heartbeat));
    teardown.track(() => { try { channel?.close?.(); } catch { /* */ } channel = null; });
  }

  /** The actual POST — never throws, never retries; the server's idle scanner is the fallback. @param {string} reason */
  async function send(reason) {
    const token = getToken();
    const id = threadId;
    if (!id || !token) return { ok: false, reason: 'no_thread' };
    const useTimeout = !!timeoutMs && !UNLOAD_REASONS.has(reason) && typeof AbortController === 'function';
    const controller = useTimeout ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${genieUrl}${path}`, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `KS ${token}` },
        body: JSON.stringify({ id }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (res && res.ok === false) {
        audit('session.complete', 'fail', { target: 'thread', action: reason, reason: `http_${res.status}` });
        return { ok: false, reason: 'http_error', status: res.status };
      }
      audit('session.complete', 'success', { target: 'thread', action: reason });
      return { ok: true, reason };
    } catch (e) {
      audit('session.complete', 'fail', { target: 'thread', action: reason, reason: String(e && e.message || e) });
      log('warn', 'session_completed POST failed', e);
      return { ok: false, reason: 'network_error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @param {string} reason */
  async function finalize(reason) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (sent) return { ok: true, reason: 'already_sent' };
    if (!threadId) return { ok: false, reason: 'no_thread' };
    sent = true;
    clearHiddenTimer();
    // Announce departure, then decide — a tab that's still the only one standing
    // fires; one with live siblings suppresses (genie self-heals on the thread's
    // next real message either way, so a false suppress is never a leak).
    post('bye');
    prunePeers();
    if (peers.size > 0) {
      audit('session.complete', 'success', { target: 'thread', action: `suppressed:peers=${peers.size}` });
      emit('sessionCompleted', { reason, sent: false, suppressed: true, peers: peers.size });
      return { ok: true, reason: 'suppressed', peers: peers.size };
    }
    const result = await send(reason);
    emit('sessionCompleted', { reason, sent: result.ok, suppressed: false, peers: 0 });
    return result;
  }

  function armHiddenGrace() {
    if (!completeOnHiddenGrace || !hiddenGraceMs) return;
    clearHiddenTimer();
    hiddenTimer = setTimeout(() => { finalize('hidden_grace').catch(() => {}); }, hiddenGraceMs);
    hiddenTimer.unref?.();
  }

  function onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') armHiddenGrace();
    else clearHiddenTimer();
  }

  /** @param {{persisted?:boolean}} [ev] */
  function onPageHide(ev) {
    if (ev?.persisted) { if (completeOnBfcache) finalize('pagehide_bfcache').catch(() => {}); return; }
    finalize('pagehide').catch(() => {});
  }

  /** @param {{persisted?:boolean}} [ev] */
  function onPageShow(ev) { if (ev?.persisted) clearHiddenTimer(); }

  return {
    /** Called the moment a real threadId arrives — opens presence; before this, nothing thread-keyed exists. @param {string} id */
    noteThreadId(id) {
      if (!enabled || !id || threadId) return;
      threadId = id;
      openPresence();
    },
    /** Wire `pagehide`/`visibilitychange`/`pageshow`. No-op in Node/SSR, when disabled, or if already wired. */
    wire() {
      if (wired || !enabled || !pageLifecycleAware || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
      wired = true;
      const add = (target, type, fn) => { target.addEventListener(type, fn); teardown.track(() => { try { target.removeEventListener(type, fn); } catch { /* */ } }); };
      add(document, 'visibilitychange', onVisibilityChange);
      add(globalThis, 'pagehide', onPageHide);
      add(globalThis, 'pageshow', onPageShow);
    },
    /** Remove every listener/timer this instance ever added. Idempotent (Teardown.run). */
    unwire() { wired = false; clearHiddenTimer(); teardown.run(); },
    /** Re-arm the hidden-grace timer on activity — an actively-talking hidden tab must never grace-complete mid-turn. */
    touch() { if (hiddenTimer) armHiddenGrace(); },
    finalize,
    /** Public entry point for an app-driven end-of-conversation signal (`completeThread()`). @param {string} [reason] */
    async complete(reason) { return finalize(reason || 'manual'); },
  };
}

// session-complete.js — the "tell genie the conversation is truly over" mechanism
// shared by KalturaAvatarSession and KalturaChatSession. Tested in isolation here;
// integration with each transport's connect/disconnect/switchMode lives in
// chat-session.test.js and test/e2e/connect.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCompleter } from '../../src/experience/session-complete.js';

/** @param {object} [overrides] */
function makeCompleter(overrides = {}) {
  const calls = [];
  const audits = [];
  const emits = [];
  let nowMs = 0;
  const fetchImpl = overrides.fetchImpl || (async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; });
  const completer = createSessionCompleter({
    fetch: fetchImpl,
    genieUrl: 'https://genie.example.com',
    path: '/thread/session_completed',
    getToken: overrides.getToken || (() => 'ks-token-abc'),
    audit: (type, outcome, fields) => audits.push({ type, outcome, fields }),
    emit: (ev, payload) => emits.push({ ev, payload }),
    log: () => {},
    now: () => nowMs,
    enabled: overrides.enabled ?? true,
    timeoutMs: overrides.timeoutMs ?? 5000,
    pageLifecycleAware: overrides.pageLifecycleAware ?? true,
    hiddenGraceMs: overrides.hiddenGraceMs ?? 30000,
    completeOnHiddenGrace: overrides.completeOnHiddenGrace ?? true,
    completeOnBfcache: overrides.completeOnBfcache ?? true,
    // Off by default in these tests — Node ships a real global BroadcastChannel,
    // and (unlike a timer) it keeps the event loop alive until closed regardless
    // of unref, with no opt-out. Tests that exercise presence explicitly opt in
    // AND swap in the in-memory FakeBroadcastChannel via stubBroadcastChannel().
    crossTabPresence: overrides.crossTabPresence ?? false,
    presenceChannelPrefix: overrides.presenceChannelPrefix ?? 'kaltura-agents:thread',
    presenceHeartbeatMs: overrides.presenceHeartbeatMs ?? 4000,
    presenceStaleMs: overrides.presenceStaleMs ?? 12000,
  });
  return { completer, calls, audits, emits, setNow: (n) => { nowMs = n; } };
}

/** Stub `document` (visibilitychange) + `globalThis` (pagehide/pageshow) event buses, Node has neither by default. */
function stubDom() {
  const docHandlers = new Map();
  const winHandlers = new Map();
  const bus = (map) => ({
    add: (type, fn) => { (map.get(type) || map.set(type, new Set()).get(type)).add(fn); },
    remove: (type, fn) => { map.get(type)?.delete(fn); },
    dispatch: (type, payload) => { for (const fn of [...(map.get(type) || [])]) fn(payload); },
  });
  const docBus = bus(docHandlers), winBus = bus(winHandlers);
  const origDocument = globalThis.document;
  const origAdd = globalThis.addEventListener, origRemove = globalThis.removeEventListener;
  globalThis.document = { visibilityState: 'visible', addEventListener: docBus.add, removeEventListener: docBus.remove };
  globalThis.addEventListener = winBus.add;
  globalThis.removeEventListener = winBus.remove;
  return {
    setHidden(hidden) { globalThis.document.visibilityState = hidden ? 'hidden' : 'visible'; docBus.dispatch('visibilitychange'); },
    pagehide(persisted) { winBus.dispatch('pagehide', { persisted }); },
    pageshow(persisted) { winBus.dispatch('pageshow', { persisted }); },
    docHandlerCount(type) { return docHandlers.get(type)?.size ?? 0; },
    winHandlerCount(type) { return winHandlers.get(type)?.size ?? 0; },
    restore() { globalThis.document = origDocument; globalThis.addEventListener = origAdd; globalThis.removeEventListener = origRemove; },
  };
}

/** Stub global setTimeout/clearTimeout so hidden-grace tests don't wait 30s of real time. */
function stubTimers() {
  let id = 0;
  const scheduled = new Map();
  const origSetTimeout = globalThis.setTimeout, origClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const h = ++id; scheduled.set(h, { fn, ms }); return h; };
  globalThis.clearTimeout = (h) => { scheduled.delete(h); };
  return {
    scheduled,
    fire(h) { const e = scheduled.get(h); scheduled.delete(h); e?.fn(); },
    fireAll() { for (const h of [...scheduled.keys()]) this.fire(h); },
    restore() { globalThis.setTimeout = origSetTimeout; globalThis.clearTimeout = origClearTimeout; },
  };
}

/** In-memory BroadcastChannel double: same `name` = same bus, delivery is async (microtask) like the real API. */
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this._listeners = new Set();
    if (!FakeBroadcastChannel._bus.has(name)) FakeBroadcastChannel._bus.set(name, new Set());
    FakeBroadcastChannel._bus.get(name).add(this);
  }
  addEventListener(type, fn) { if (type === 'message') this._listeners.add(fn); }
  removeEventListener(type, fn) { if (type === 'message') this._listeners.delete(fn); }
  postMessage(data) {
    for (const peer of FakeBroadcastChannel._bus.get(this.name)) {
      if (peer === this) continue;
      queueMicrotask(() => { for (const fn of peer._listeners) fn({ data }); });
    }
  }
  close() { FakeBroadcastChannel._bus.get(this.name)?.delete(this); }
}
FakeBroadcastChannel._bus = new Map();

function stubBroadcastChannel() {
  FakeBroadcastChannel._bus.clear();
  const orig = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  return { restore() { globalThis.BroadcastChannel = orig; } };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── the POST itself ─────────────────────────

test('finalize() POSTs {id:threadId} with Authorization: KS <token>, keepalive:true', async () => {
  const { completer, calls, audits } = makeCompleter();
  completer.noteThreadId('thread-1');
  const r = await completer.finalize('disconnect');
  assert.deepEqual(r, { ok: true, reason: 'disconnect' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://genie.example.com/thread/session_completed');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.keepalive, true);
  assert.equal(calls[0].init.headers.Authorization, 'KS ks-token-abc');
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'thread-1' });
  assert.deepEqual(audits[0], { type: 'session.complete', outcome: 'success', fields: { target: 'thread', action: 'disconnect' } });
});

test('finalize() is idempotent: a second call resolves already_sent and never re-POSTs', async () => {
  const { completer, calls } = makeCompleter();
  completer.noteThreadId('thread-1');
  await completer.finalize('disconnect');
  const second = await completer.finalize('stop');
  assert.deepEqual(second, { ok: true, reason: 'already_sent' });
  assert.equal(calls.length, 1, 'still exactly one POST');
});

test('enabled:false — finalize() no-ops and wire() registers no listeners', () => {
  const { completer, calls } = makeCompleter({ enabled: false });
  const dom = stubDom();
  try {
    completer.noteThreadId('thread-1');
    completer.wire();
    assert.equal(dom.docHandlerCount('visibilitychange'), 0);
    assert.equal(dom.winHandlerCount('pagehide'), 0);
  } finally { dom.restore(); }
  return completer.finalize('disconnect').then((r) => {
    assert.deepEqual(r, { ok: false, reason: 'disabled' });
    assert.equal(calls.length, 0);
  });
});

test('no threadId yet — finalize() sends nothing', async () => {
  const { completer, calls } = makeCompleter();
  const r = await completer.finalize('disconnect');
  assert.deepEqual(r, { ok: false, reason: 'no_thread' });
  assert.equal(calls.length, 0);
});

test('threadId present but no token — finalize() sends nothing, distinct reason from no_thread', async () => {
  const { completer, calls } = makeCompleter({ getToken: () => null });
  completer.noteThreadId('thread-1');
  const r = await completer.finalize('disconnect');
  assert.deepEqual(r, { ok: false, reason: 'no_token' });
  assert.equal(calls.length, 0);
});

test('a failed send() does not permanently lock out retries — a later finalize() call can still succeed', async () => {
  let shouldFail = true;
  const { completer, calls } = makeCompleter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (shouldFail) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    },
  });
  completer.noteThreadId('thread-1');
  const first = await completer.finalize('pagehide');
  assert.deepEqual(first, { ok: false, reason: 'http_error', status: 500 });
  shouldFail = false;
  const second = await completer.finalize('pagehide');
  assert.deepEqual(second, { ok: true, reason: 'pagehide' });
  assert.equal(calls.length, 2, 'the failed attempt did not lock out the retry');
});

test('fetch rejection never throws — resolves network_error and audits a fail with a reason', async () => {
  const { completer, audits } = makeCompleter({ fetchImpl: async () => { throw new Error('offline'); } });
  completer.noteThreadId('thread-1');
  const r = await completer.finalize('pagehide');
  assert.deepEqual(r, { ok: false, reason: 'network_error' });
  assert.equal(audits[0].outcome, 'fail');
  assert.equal(audits[0].fields.reason, 'offline');
});

test('an HTTP error response (res.ok:false) is not reported as success', async () => {
  const { completer, audits } = makeCompleter({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  completer.noteThreadId('thread-1');
  const r = await completer.finalize('pagehide');
  assert.deepEqual(r, { ok: false, reason: 'http_error', status: 500 });
  assert.equal(audits[0].outcome, 'fail');
  assert.equal(audits[0].fields.reason, 'http_500');
});

test('complete(reason) is the public entry point for finalize()', async () => {
  const { completer, calls } = makeCompleter();
  completer.noteThreadId('thread-1');
  await completer.complete('manual');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).id, 'thread-1');
});

// ───────────────────────── page lifecycle listeners ─────────────────────────

test('wire() is a no-op when globalThis has no addEventListener (document exists but window does not)', () => {
  const { completer } = makeCompleter();
  const dom = stubDom();
  const origAdd = globalThis.addEventListener;
  delete globalThis.addEventListener;
  try {
    completer.wire();
    assert.equal(dom.docHandlerCount('visibilitychange'), 0);
  } finally {
    globalThis.addEventListener = origAdd;
    dom.restore();
  }
});

test('wire()/unwire() add and remove exactly their own listeners (idempotent unwire)', () => {
  const { completer } = makeCompleter();
  const dom = stubDom();
  try {
    completer.wire();
    assert.equal(dom.docHandlerCount('visibilitychange'), 1);
    assert.equal(dom.winHandlerCount('pagehide'), 1);
    assert.equal(dom.winHandlerCount('pageshow'), 1);
    completer.unwire();
    assert.equal(dom.docHandlerCount('visibilitychange'), 0);
    assert.equal(dom.winHandlerCount('pagehide'), 0);
    assert.equal(dom.winHandlerCount('pageshow'), 0);
    completer.unwire();   // idempotent — no throw, nothing left to remove
  } finally { dom.restore(); }
});

test('wire() called twice does not double-register listeners', () => {
  const { completer } = makeCompleter();
  const dom = stubDom();
  try {
    completer.wire();
    completer.wire();
    assert.equal(dom.docHandlerCount('visibilitychange'), 1);
    assert.equal(dom.winHandlerCount('pagehide'), 1);
    assert.equal(dom.winHandlerCount('pageshow'), 1);
    completer.unwire();
    completer.wire();   // wire() after unwire() re-wires normally
    assert.equal(dom.docHandlerCount('visibilitychange'), 1);
  } finally { dom.restore(); }
});

test('pagehide (persisted:false) fires finalize with reason "pagehide"', async () => {
  const { completer, calls } = makeCompleter();
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  try {
    completer.wire();
    dom.pagehide(false);
    await delay(5);
  } finally { dom.restore(); }
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'thread-1' });
});

test('pagehide bfcache (persisted:true) fires when completeOnBfcache is true, reason "pagehide_bfcache"', async () => {
  const { completer, calls, audits } = makeCompleter({ completeOnBfcache: true });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  try { completer.wire(); dom.pagehide(true); await delay(5); } finally { dom.restore(); }
  assert.equal(calls.length, 1);
  assert.equal(audits[0].fields.action, 'pagehide_bfcache');
});

test('completeOnBfcache:false — bfcache pagehide never fires', async () => {
  const { completer, calls } = makeCompleter({ completeOnBfcache: false });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  try { completer.wire(); dom.pagehide(true); await delay(5); } finally { dom.restore(); }
  assert.equal(calls.length, 0);
});

// ───────────────────────── hidden-grace timer ─────────────────────────

test('hidden longer than hiddenGraceMs fires finalize with reason "hidden_grace"', () => {
  const { completer, calls } = makeCompleter({ hiddenGraceMs: 30000 });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  const timers = stubTimers();
  try {
    completer.wire();
    dom.setHidden(true);
    assert.equal(timers.scheduled.size, 1);
    const [[h, e]] = timers.scheduled;
    assert.equal(e.ms, 30000);
    timers.fire(h);
  } finally { dom.restore(); timers.restore(); }
  return delay(5).then(() => {
    assert.equal(calls.length, 1);
  });
});

test('returning to visible before the grace timer fires cancels it', () => {
  const { completer, calls } = makeCompleter({ hiddenGraceMs: 30000 });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  const timers = stubTimers();
  try {
    completer.wire();
    dom.setHidden(true);
    assert.equal(timers.scheduled.size, 1);
    dom.setHidden(false);
    assert.equal(timers.scheduled.size, 0, 'going visible clears the pending grace timer');
  } finally { dom.restore(); timers.restore(); }
  assert.equal(calls.length, 0);
});

test('completeOnHiddenGrace:false — going hidden never arms a timer', () => {
  const { completer } = makeCompleter({ completeOnHiddenGrace: false });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  const timers = stubTimers();
  try {
    completer.wire();
    dom.setHidden(true);
    assert.equal(timers.scheduled.size, 0);
  } finally { dom.restore(); timers.restore(); }
});

test('touch() re-arms an already-running grace timer (activity while hidden must not grace-complete mid-turn)', () => {
  const { completer } = makeCompleter({ hiddenGraceMs: 30000 });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  const timers = stubTimers();
  try {
    completer.wire();
    dom.setHidden(true);
    const firstHandle = [...timers.scheduled.keys()][0];
    completer.touch();
    assert.equal(timers.scheduled.has(firstHandle), false, 'the original timer was cleared');
    assert.equal(timers.scheduled.size, 1, 'exactly one fresh timer took its place');
  } finally { dom.restore(); timers.restore(); }
});

test('touch() is a no-op when the page is not currently in a hidden-grace window', () => {
  const { completer } = makeCompleter();
  const timers = stubTimers();
  try {
    completer.touch();
    assert.equal(timers.scheduled.size, 0);
  } finally { timers.restore(); }
});

test('pageshow persisted:true clears a pending hidden-grace timer (bfcache restore)', () => {
  const { completer } = makeCompleter({ hiddenGraceMs: 30000 });
  completer.noteThreadId('thread-1');
  const dom = stubDom();
  const timers = stubTimers();
  try {
    completer.wire();
    dom.setHidden(true);
    assert.equal(timers.scheduled.size, 1);
    dom.pageshow(true);
    assert.equal(timers.scheduled.size, 0);
  } finally { dom.restore(); timers.restore(); }
});

// ───────────────────────── multi-tab presence (BroadcastChannel) ─────────────────────────

test('a second live tab on the same thread suppresses the POST; the last tab standing still fires', async () => {
  const bc = stubBroadcastChannel();
  try {
    const a = makeCompleter({ crossTabPresence: true });
    const b = makeCompleter({ crossTabPresence: true });
    a.completer.noteThreadId('thread-shared');
    b.completer.noteThreadId('thread-shared');
    await delay(5);   // let hello/ack round-trip settle

    const rA = await a.completer.finalize('pagehide');
    assert.deepEqual(rA, { ok: true, reason: 'suppressed', peers: 1 });
    assert.equal(a.calls.length, 0, 'A suppresses because B is still alive');
    assert.equal(a.audits[0].fields.action, 'suppressed:peers=1');

    await delay(5);
    const rB = await b.completer.finalize('pagehide');
    assert.equal(rB.ok, true);
    assert.equal(b.calls.length, 1, 'B is now the last tab standing and fires');
  } finally { bc.restore(); }
});

test('a stale peer (unseen past presenceStaleMs) is pruned and no longer suppresses', async () => {
  const bc = stubBroadcastChannel();
  try {
    const a = makeCompleter({ presenceStaleMs: 1000, crossTabPresence: true });
    const b = makeCompleter({ presenceStaleMs: 1000, crossTabPresence: true });
    a.completer.noteThreadId('thread-shared-2');
    b.completer.noteThreadId('thread-shared-2');
    await delay(5);
    a.setNow(5000);   // A's clock has advanced well past B's last-seen timestamp of 0
    const rA = await a.completer.finalize('pagehide');
    assert.deepEqual(rA, { ok: true, reason: 'pagehide' }, 'stale peer pruned — no suppression');
    assert.equal(a.calls.length, 1);
  } finally { bc.restore(); }
});

test('crossTabPresence:false — no BroadcastChannel opened, always fires regardless of other instances', async () => {
  const bc = stubBroadcastChannel();
  try {
    const a = makeCompleter({ crossTabPresence: false });
    const b = makeCompleter({ crossTabPresence: false });
    a.completer.noteThreadId('thread-solo');
    b.completer.noteThreadId('thread-solo');
    await delay(5);
    const rA = await a.completer.finalize('pagehide');
    assert.deepEqual(rA, { ok: true, reason: 'pagehide' });
    assert.equal(a.calls.length, 1);
  } finally { bc.restore(); }
});

test('no BroadcastChannel global (old webview / crossTabPresence unset) — degrades to always-fires, no throw', async () => {
  const orig = globalThis.BroadcastChannel;
  // simulate an environment where the constructor genuinely does not exist
  delete globalThis.BroadcastChannel;
  try {
    const { completer, calls } = makeCompleter({ crossTabPresence: true });
    completer.noteThreadId('thread-nowebview');
    const r = await completer.finalize('pagehide');
    assert.deepEqual(r, { ok: true, reason: 'pagehide' });
    assert.equal(calls.length, 1);
  } finally { globalThis.BroadcastChannel = orig; }
});

test('unwire() closes the presence channel — a finalize() after unwire() still works standalone', async () => {
  const bc = stubBroadcastChannel();
  try {
    const { completer, calls } = makeCompleter({ crossTabPresence: true });
    completer.noteThreadId('thread-close');
    completer.unwire();
    const r = await completer.finalize('disconnect');
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1, 'no peers left to suppress once the channel is closed');
  } finally { bc.restore(); }
});

// ───────────────────────── Node/SSR (no document, no BroadcastChannel) ─────────────────────────

test('Node/SSR: no document (Node\'s own BroadcastChannel/crossTabPresence gate is a session.js/chat-session.js concern, not this module\'s) — wire()/unwire()/finalize() never throw', async () => {
  assert.equal(typeof document, 'undefined');
  // Mirrors the real default each transport computes in Node: crossTabPresence
  // gates on `document` existing, so it's off here even though Node ships a
  // global BroadcastChannel (see session.js/chat-session.js ctor comments).
  const { completer, calls } = makeCompleter({ crossTabPresence: false });
  completer.noteThreadId('thread-node');
  completer.wire();
  completer.touch();
  const r = await completer.finalize('disconnect');
  assert.deepEqual(r, { ok: true, reason: 'disconnect' });
  assert.equal(calls.length, 1);
  completer.unwire();
});

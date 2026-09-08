import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SiteNavigator } from '../../src/experience/site-nav.js';
import { Emitter } from '../../src/experience/emitter.js';
import { buildSectionsManifest } from '../../src/core/site-keys.js';

/** Mirrors session.js#onToolCall + on('turnStart') as the plugin sees them. */
class FakeSession extends Emitter {
  constructor() { super(); this._toolCallHandlers = new Map(); }
  onToolCall(name, handler) {
    const l = this._toolCallHandlers.get(name) || []; l.push(handler); this._toolCallHandlers.set(name, l);
    return () => { const list = this._toolCallHandlers.get(name); if (!list) return; const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); if (!list.length) this._toolCallHandlers.delete(name); };
  }
  /** Fire a tool call and return the handlers' promises so tests can await the full effect. */
  fireToolCall(name, args) { return Promise.all((this._toolCallHandlers.get(name) || []).map((h) => h(args))); }
  get handlerCount() { return [...this._toolCallHandlers.values()].reduce((n, l) => n + l.length, 0); }
}

const MANIFEST = buildSectionsManifest([
  { path: '/', headings: [{ id: 'quick-start', text: 'Quick start', level: 2 }] },
  { path: '/guides/pause-resume/', headings: [
    { id: 'what-it-is', text: 'What it is', level: 2 },
    { id: 'the-edge-case-dont-leave-the-avatar-stuck-paused', text: "The edge case: don't leave the avatar stuck paused", level: 2 },
    { id: 'salesforce-example', text: 'Salesforce example', level: 2 },
  ] },
  { path: '/reference/api/', headings: [{ id: 'tools', text: 'Tools', level: 2 }] },
], { generatedAt: 't' });

/** A fresh jsdom window at `pathname` with `requestAnimationFrame` available (pretendToBeVisual). */
function makeWindow(pathname = '/', html = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `https://docs.example.com${pathname}`, pretendToBeVisual: true });
  return dom.window;
}
const section = (id) => `<h2 id="${id}">${id}</h2>`;

/** Build a navigator over a fake session and jsdom window; `navigate` swaps the body to simulate a SPA route change. */
function setup(over = {}) {
  const session = new FakeSession();
  const win = over.window || makeWindow(over.pathname || '/', over.html || '');
  const events = [];
  const navigated = [];
  const pointed = [];
  const scrolled = [];
  for (const id of ['quick-start', 'what-it-is', 'the-edge-case-dont-leave-the-avatar-stuck-paused', 'salesforce-example', 'tools']) {
    const el = win.document?.getElementById(id);
    if (el) el.scrollIntoView = () => scrolled.push(id);
  }
  const nav = new SiteNavigator({
    session,
    window: win,
    manifest: over.manifest === undefined ? MANIFEST : over.manifest,
    navigate: over.navigate || (async (url, info) => {
      navigated.push(url);
      // SPA: the new page's headings appear only after navigate resolves (next frame).
      const page = MANIFEST.pages.find((p) => p.path === info.path);
      if (!win.document) return;
      setTimeout(() => {
        win.document.body.innerHTML = page.sections.map((s) => section(s.id)).join('');
        for (const s of page.sections) win.document.getElementById(s.id).scrollIntoView = () => scrolled.push(s.id);
      }, 0);
    }),
    point: (el, info) => pointed.push([el.id, info.section]),
    onNavigate: (info) => events.push(info),
    warn: (m) => events.push({ warn: m }),
    settleMs: 5,
    ...over.cfg,
  });
  return { session, win, nav, events, navigated, pointed, scrolled };
}

test('constructor validates its inputs', () => {
  assert.throws(() => new SiteNavigator({}), /needs \{ session \}/);
  assert.throws(() => new SiteNavigator({ session: new FakeSession() }), /needs \{ navigate \}/);
  assert.throws(() => new SiteNavigator({ session: new FakeSession(), navigate: () => {} }), /needs \{ manifest \} or \{ manifestUrl \}/);
});

test('go_to to another page with a section: navigate first, then scroll, hash, point, onNavigate', async () => {
  const { session, win, events, navigated, pointed, scrolled } = setup();
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'edge-case-dont' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#the-edge-case-dont-leave-the-avatar-stuck-paused']);
  assert.deepEqual(scrolled, ['the-edge-case-dont-leave-the-avatar-stuck-paused']);
  assert.deepEqual(pointed, [['the-edge-case-dont-leave-the-avatar-stuck-paused', 'edge-case-dont']]);
  assert.equal(win.location.hash, '#the-edge-case-dont-leave-the-avatar-stuck-paused');
  assert.equal(events.length, 1);
  const info = events[0];
  assert.equal(info.path, '/guides/pause-resume/');
  assert.equal(info.section, 'edge-case-dont');
  assert.equal(info.sectionId, 'the-edge-case-dont-leave-the-avatar-stuck-paused');
  assert.equal(info.resolvedBy, 'key');
  assert.equal(info.fellBackToTop, false);
  assert.equal(info.splitPath, false);
  assert.equal(info.samePage, false);
  assert.equal(info.sectionFound, true);
  assert.deepEqual(info.args, { path: '/guides/pause-resume/', section: 'edge-case-dont' });
});

test('go_to with only a path: navigate to the page top, no hash, no point', async () => {
  const { session, win, events, navigated, pointed } = setup();
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated, ['/reference/api/']);
  assert.deepEqual(pointed, []);
  assert.equal(win.location.hash, '');
  assert.equal(events[0].section, null);
  assert.equal(events[0].sectionId, null);
  assert.equal(events[0].fellBackToTop, false);
  assert.equal(events[0].sectionFound, undefined);
});

test('unknown path is dropped: no navigate, no turn slot used', async () => {
  const { session, events, navigated } = setup();
  await session.fireToolCall('go_to', { path: '/docs/faq/', section: 'x' });
  assert.deepEqual(navigated, []);
  assert.deepEqual(events, [{ dropped: true, reason: 'unknown_path', args: { path: '/docs/faq/', section: 'x' } }]);
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated, ['/reference/api/'], 'the invalid call did not use up the once-per-turn slot');
});

test('section glued onto the path navigates to the parent page and that section', async () => {
  const { session, events, navigated, pointed } = setup({ pathname: '/reference/api/' });
  await session.fireToolCall('go_to', { path: '/quick-start' });
  assert.deepEqual(navigated, ['/#quick-start']);
  assert.deepEqual(pointed, [['quick-start', 'quick-start']]);
  const info = events[0];
  assert.equal(info.path, '/');
  assert.equal(info.section, 'quick-start');
  assert.equal(info.resolvedBy, 'key');
  assert.equal(info.splitPath, true);
  assert.equal(info.fellBackToTop, false);
  assert.equal(info.sectionFound, true);
  assert.deepEqual(info.args, { path: '/quick-start' });
});

test('section glued onto a nested page path resolves too', async () => {
  const { session, events, navigated } = setup();
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/salesforce-example/' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#salesforce-example']);
  assert.equal(events[0].splitPath, true);
  assert.equal(events[0].section, 'salesforce-example');
});

test('sloppy path and section still resolve', async () => {
  const { session, events, navigated } = setup();
  await session.fireToolCall('go_to', { path: 'Guides/Pause-Resume', section: 'stuck paused' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#the-edge-case-dont-leave-the-avatar-stuck-paused']);
  assert.equal(events[0].resolvedBy, 'subset');
});

test('unknown section falls back to the page top with fellBackToTop', async () => {
  const { session, events, navigated, pointed } = setup();
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'troubleshooting' });
  assert.deepEqual(navigated, ['/guides/pause-resume/']);
  assert.deepEqual(pointed, []);
  assert.equal(events[0].fellBackToTop, true);
  assert.equal(events[0].section, null);
});

test('once per turn: second valid call in the same turn is dropped, turnStart resets', async () => {
  const { session, events, navigated } = setup();
  await Promise.all([
    session.fireToolCall('go_to', { path: '/reference/api/' }),
    session.fireToolCall('go_to', { path: '/guides/pause-resume/' }),
  ]);
  assert.deepEqual(navigated, ['/reference/api/']);
  // The second call is rejected synchronously, so its drop lands before the first call's completion event.
  assert.deepEqual(events.map((e) => e.dropped ? e.reason : e.path), ['once_per_turn', '/reference/api/']);
  session.emit('turnStart', { isNewTurn: false });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/' });
  assert.equal(navigated.length, 1, 'isNewTurn:false does not reset');
  session.emit('turnStart', { isNewTurn: true });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/' });
  assert.deepEqual(navigated, ['/reference/api/', '/guides/pause-resume/']);
});

test('oncePerTurn:false executes every valid call', async () => {
  const { session, navigated } = setup({ cfg: { oncePerTurn: false } });
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/' });
  assert.equal(navigated.length, 2);
});

test('same page: navigate skipped, section scrolled immediately', async () => {
  const { session, events, navigated, scrolled } = setup({ pathname: '/guides/pause-resume/', html: section('salesforce-example') });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'salesforce-example' });
  assert.deepEqual(navigated, []);
  assert.deepEqual(scrolled, ['salesforce-example']);
  assert.equal(events[0].samePage, true);
  assert.equal(events[0].sectionFound, true);
});

test('same page, section element missing: reported, nothing thrown', async () => {
  const { session, events, scrolled } = setup({ pathname: '/guides/pause-resume/', html: '' });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'salesforce-example' });
  assert.deepEqual(scrolled, []);
  assert.equal(events[0].sectionFound, false);
});

test('section not in DOM after navigate: one frame, one settle retry, then give up', async () => {
  const { session, events, navigated } = setup({ navigate: async (url) => navigated.push(url) });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'what-it-is' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#what-it-is']);
  assert.equal(events[0].sectionFound, false);
});

test('custom scrollTo and currentPath, updateHash:false', async () => {
  const seen = [];
  const { session, win, events, navigated } = setup({
    pathname: '/other/', html: section('salesforce-example'),
    cfg: { scrollTo: (el) => seen.push(el.id), currentPath: () => '/guides/pause-resume/', updateHash: false },
  });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'salesforce-example' });
  assert.deepEqual(navigated, [], 'currentPath says we are already there');
  assert.deepEqual(seen, ['salesforce-example']);
  assert.equal(win.location.hash, '');
  assert.equal(events[0].url, '/guides/pause-resume/', 'no hash appended when updateHash is off');
});

test('pathPrefix is prepended to the URL and stripped from location', async () => {
  const { session, navigated } = setup({ pathname: '/docs/reference/api/', cfg: { pathPrefix: '/docs/' } });
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated, [], 'already on /docs/reference/api/');
  session.emit('turnStart', { isNewTurn: true });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'what-it-is' });
  assert.deepEqual(navigated, ['/docs/guides/pause-resume/#what-it-is']);
});

test('pathPrefix trailing slashes are all stripped, whatever their count', async () => {
  const { session, navigated } = setup({ pathname: '/docs/', cfg: { pathPrefix: `/docs${'/'.repeat(5000)}` } });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/' });
  assert.deepEqual(navigated, ['/docs/guides/pause-resume/']);
});

test('a manifest path that is not a safe relative URL is dropped', async () => {
  const bad = { version: 1, lang: 'en', generatedAt: 't', pages: [{ path: '//evil.example/x', sections: [] }] };
  const { session, events, navigated } = setup({ manifest: bad });
  await session.fireToolCall('go_to', { path: '//evil.example/x' });
  assert.deepEqual(navigated, []);
  assert.equal(events[0].reason, 'unsafe_url');
});

test('non-object args are treated as empty', async () => {
  const { session, events } = setup();
  await session.fireToolCall('go_to', 'nope');
  assert.equal(events[0].reason, 'unknown_path');
  assert.deepEqual(events[0].args, {});
});

test('destroy() is idempotent, unsubscribes, stops an in-flight call; stop() is an alias', async () => {
  const { session, nav, events, navigated } = setup({ navigate: async (url) => { navigated.push(url); nav.destroy(); } });
  assert.equal(session.handlerCount, 1);
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'what-it-is' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#what-it-is']);
  assert.deepEqual(events, [], 'destroyed mid-flight: no onNavigate, no DOM work');
  nav.destroy();
  nav.stop();
  assert.equal(session.handlerCount, 0);
  assert.equal(session._toolCallHandlers.has('go_to'), false);
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated.length, 1);
});

test('two live navigators on one session warn; destroying the first clears it', () => {
  const session = new FakeSession();
  const warnings = [];
  const mk = () => new SiteNavigator({ session, manifest: MANIFEST, navigate: () => {}, warn: (m) => warnings.push(m), window: makeWindow() });
  const a = mk();
  const b = mk();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /already live on this session/);
  a.destroy();
  mk().destroy();
  assert.equal(warnings.length, 2, 'b is still live, so a third navigator warns');
  b.destroy();
  b.destroy();
  mk().destroy();
  assert.equal(warnings.length, 2, 'all destroyed (double destroy counted once): no warning');
});

test('manifestUrl: fetched, size-guarded, validated; inline manifest serves meanwhile', async () => {
  const win = makeWindow('/');
  const fetched = [];
  win.fetch = async (url) => { fetched.push(url); return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(MANIFEST) }; };
  const { session, nav, navigated } = setup({ window: win, manifest: { version: 1, pages: [{ path: '/reference/api/', sections: [] }] }, cfg: { manifestUrl: '/nova/sections.json' } });
  assert.equal(nav.manifest.pages.length, 1, 'inline manifest until fetch resolves');
  await nav.ready;
  assert.deepEqual(fetched, ['/nova/sections.json']);
  assert.equal(nav.manifest.pages.length, 3);
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/' });
  assert.deepEqual(navigated, ['/guides/pause-resume/']);
});

test('manifestUrl only: calls wait for the fetch, then run', async () => {
  const win = makeWindow('/');
  let release;
  win.fetch = () => new Promise((r) => { release = () => r({ ok: true, status: 200, headers: { get: () => '10' }, text: async () => JSON.stringify(MANIFEST) }); });
  const { session, nav, navigated } = setup({ window: win, manifest: null, cfg: { manifestUrl: '/nova/sections.json' } });
  assert.equal(nav.manifest, null);
  const pending = session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated, []);
  release();
  await pending;
  assert.deepEqual(navigated, ['/reference/api/']);
});

test('manifestUrl failures warn and drop calls with no_manifest', async () => {
  const cases = [
    ['HTTP 500', () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => '' })],
    ['content-length over limit', () => ({ ok: true, status: 200, headers: { get: () => '9999999' }, text: async () => '{}' })],
    ['body over limit', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'x'.repeat(600 * 1024) })],
    ['invalid JSON', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{oops' })],
    ['wrong version', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ version: 9, pages: [] }) })],
    ['network error', () => { throw new Error('offline'); }],
  ];
  for (const [label, impl] of cases) {
    const win = makeWindow('/');
    win.fetch = async () => impl();
    const { session, nav, events, navigated } = setup({ window: win, manifest: null, cfg: { manifestUrl: '/nova/sections.json' } });
    await nav.ready;
    assert.equal(nav.manifest, null, label);
    assert.equal(events.length, 1, label);
    assert.match(events[0].warn, /sections manifest not loaded from \/nova\/sections\.json/, label);
    await session.fireToolCall('go_to', { path: '/reference/api/' });
    assert.deepEqual(navigated, [], label);
    assert.equal(events[1].reason, 'no_manifest', label);
  }
  const win = makeWindow('/');
  win.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(MANIFEST) });
  const { nav, events } = setup({ window: win, manifest: null, cfg: { manifestUrl: 'javascript:alert(1)' } });
  await nav.ready;
  assert.match(events[0].warn, /unsafe manifest URL/);
  const noFetch = makeWindow('/');
  noFetch.fetch = undefined;
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const r = setup({ window: noFetch, manifest: null, cfg: { manifestUrl: '/nova/sections.json' } });
    await r.nav.ready;
    assert.match(r.events[0].warn, /fetch is not available/);
  } finally { globalThis.fetch = saved; }
});

test('navigator survives a window without history, rAF or document', async () => {
  const bare = { location: { pathname: '/' } };
  const { session, events, navigated } = setup({ window: bare });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'what-it-is' });
  assert.deepEqual(navigated, ['/guides/pause-resume/#what-it-is']);
  assert.equal(events[0].sectionFound, false);
  const noLoc = setup({ window: {} });
  await noLoc.session.fireToolCall('go_to', { path: '/' });
  assert.equal(noLoc.events[0].samePage, false, 'no location: never assume same page');
});

test('defaults: onNavigate is a no-op, warn goes to console.warn, no requestAnimationFrame falls back to a timer', async () => {
  const win = makeWindow('/');
  win.requestAnimationFrame = undefined;
  const warned = [];
  const saved = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    const session = new FakeSession();
    const navigated = [];
    const nav = new SiteNavigator({
      session, window: win, manifest: MANIFEST,
      navigate: async (url) => { navigated.push(url); setTimeout(() => { win.document.body.innerHTML = section('tools'); }, 0); },
    });
    new SiteNavigator({ session, window: win, manifest: MANIFEST, navigate: () => {} }).destroy();
    assert.equal(warned.length, 1);
    assert.match(warned[0], /already live/);
    await session.fireToolCall('go_to', { path: '/reference/api/', section: 'tools' });
    assert.deepEqual(navigated, ['/reference/api/#tools']);
    assert.equal(win.location.hash, '#tools', 'section found on the timer-based retry');
    nav.destroy();
  } finally { console.warn = saved; }
});

test('a throwing replaceState is swallowed', async () => {
  const win = makeWindow('/', '');
  win.history.replaceState = () => { throw new Error('sandboxed'); };
  const { session, events } = setup({ window: win });
  await session.fireToolCall('go_to', { path: '/guides/pause-resume/', section: 'what-it-is' });
  assert.equal(events[0].sectionFound, true);
});

test('custom toolCallName', async () => {
  const { session, navigated } = setup({ cfg: { toolCallName: 'open_page' } });
  await session.fireToolCall('go_to', { path: '/reference/api/' });
  assert.deepEqual(navigated, []);
  await session.fireToolCall('open_page', { path: '/reference/api/' });
  assert.deepEqual(navigated, ['/reference/api/']);
});

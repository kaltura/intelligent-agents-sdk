import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Presenter } from '../../src/experience/presenter.js';
import { parseSlideNumber } from '../../src/experience/slidenav.js';
import { Emitter } from '../../src/experience/emitter.js';

/** A fake session: an Emitter that records every setDynamicPrompt payload. */
class FakeSession extends Emitter {
  constructor() { super(); this.dpps = []; this.connected = true; this._toolCallHandlers = new Map(); }
  setDynamicPrompt(data) { if (!this.connected) { const e = new Error('not connected'); e.code = 'invalid_state'; throw e; } this.dpps.push(data); }
  get lastDpp() { return this.dpps[this.dpps.length - 1]; }
  /** Mirrors the real session.js#onToolCall(name, handler) surface for tests — including its exact unsubscribe-closure contract: once the last handler for `name` is removed, the map key itself is deleted (not just emptied). */
  onToolCall(name, handler) {
    const l = this._toolCallHandlers.get(name) || []; l.push(handler); this._toolCallHandlers.set(name, l);
    return () => { const list = this._toolCallHandlers.get(name); if (!list) return; const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); if (!list.length) this._toolCallHandlers.delete(name); };
  }
  /** Test helper: fire a registered tool-call handler as the real session would. */
  fireToolCall(name, args) { for (const h of this._toolCallHandlers.get(name) || []) h(args); }
}
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
const SLIDES = [
  { title: 'Title', talking_points: ['hi'], category: 'intro' },
  { title: 'Revenue', talking_points: ['up 12%'], category: 'financial', content: { rev: 100, visual: 'chart.png' } },
  { title: 'Outlook', talking_points: ['guidance'], category: 'financial' },
  { title: 'Legal', talking_points: ['safe harbor'], category: 'legal' },
  { title: 'Q&A', talking_points: ['ask me'], category: 'closing' },
];
const newPresenter = (over = {}) => {
  const session = new FakeSession();
  const p = new Presenter({ session, slides: over.slides || SLIDES, context: over.context, onSlideChange: over.onSlideChange, storage: over.storage, ...over.cfg });
  return { session, p };
};

test('parseSlideNumber: digits, words, hyphen, bounds, prefixes', () => {
  assert.equal(parseSlideNumber('24', 62), 24);
  assert.equal(parseSlideNumber('twenty-four', 62), 24);
  assert.equal(parseSlideNumber('twenty four', 62), 24);
  assert.equal(parseSlideNumber('number 7', 62), 7);
  assert.equal(parseSlideNumber('slide 3', 62), 3);
  assert.equal(parseSlideNumber('seven', 62), 7);
  assert.equal(parseSlideNumber('100', 62), null, 'out of range → null');
  assert.equal(parseSlideNumber('0', 62), null);
  assert.equal(parseSlideNumber('banana'), null);
  assert.equal(parseSlideNumber(null), null);
});

test('constructor validates session + non-empty slides', () => {
  assert.throws(() => new Presenter({ slides: SLIDES }), /needs \{ session \}/);
  assert.throws(() => new Presenter({ session: new FakeSession(), slides: [] }), /non-empty slides/);
});

test('start injects slide-1 DPP with category + merged context, visual stripped', () => {
  const { session, p } = newPresenter({ context: { ticker: 'KLTR' } });
  p.start();
  const d = session.lastDpp;
  assert.equal(d.current_slide, 1);
  assert.equal(d.total_slides, 5);
  assert.equal(d.slide.title, 'Title');
  assert.equal(d.ticker, 'KLTR', 'context merged');
  // financial meta defaults
  p.goTo(2);
  assert.equal(session.lastDpp.meta.disclaimer_required, true);
  assert.equal(session.lastDpp.meta.non_gaap_cited, true);
  assert.equal(session.lastDpp.slide.content.visual, undefined, 'visual stripped from DPP');
  assert.equal(session.lastDpp.slide.content.rev, 100);
});

test('goTo: bounds, dedupe-to-same, fires onSlideChange + DPP, tracks current', () => {
  const seen = [];
  const { session, p } = newPresenter({ onSlideChange: (n, _s, r) => seen.push([n, r]) });
  p.start();
  const before = session.dpps.length;
  p.goTo(0); p.goTo(99); p.goTo(1);            // all no-ops (out of range / same)
  assert.equal(session.dpps.length, before, 'no DPP for invalid/same nav');
  p.goTo(3, 'user');
  assert.equal(p.current, 3);
  assert.deepEqual(seen, [[3, 'user']]);
});

test('onTurnText: CHUNKED brain segments accumulate per turn (app-hook accumulator, not nav)', () => {
  const seen = [];
  const { session, p } = newPresenter({ cfg: { onTurnText: (_chunk, full) => seen.push(full) } });
  p.start();
  session.emit('turnStart', { isNewTurn: true, speechId: 'T1' });
  session.emit('brainSegment', { type: 'avatar', content: 'Sure, ', speechId: 'T1' });
  session.emit('brainSegment', { type: 'avatar', content: 'let me pull that up.', speechId: 'T1' });
  assert.deepEqual(seen, ['Sure, ', 'Sure, let me pull that up.']);
  assert.equal(p.current, 1, 'accumulated speech never drives navigation — only the tool call does');
});

test('onTurnText: new speechId resets the accumulator (no cross-turn bleed)', () => {
  const seen = [];
  const { session, p } = newPresenter({ cfg: { onTurnText: (_chunk, full) => seen.push(full) } });
  p.start();
  session.emit('brainSegment', { type: 'avatar', content: 'part one ', speechId: 'A' });
  session.emit('brainSegment', { type: 'avatar', content: 'part two.', speechId: 'B' });   // different turn → 'part one ' dropped
  assert.deepEqual(seen, ['part one ', 'part two.']);
});

test('REGRESSION: narrating ordinary text never navigates — only the tool call does', () => {
  // The old spoken-nav fallback parsed the avatar's own narration for phrases like
  // "continuing the presentation" or "the previous slide" and could misfire on ordinary
  // wording ("continuing to grow throughout this presentation"). That fallback is removed
  // entirely: navigation is ONLY ever driven by the navigate_to_slide tool call.
  const { session, p } = newPresenter();
  p.start(); p.goTo(4, 'user');
  session.emit('avatarStopTalking', { text: 'We are continuing to grow revenue throughout this presentation, up 12% year over year.' });
  assert.equal(p.current, 4, 'narration never triggers a nav');
  session.emit('avatarStopTalking', { text: 'Continuing the presentation. Moving to the next slide. Going back to the previous slide.' });
  assert.equal(p.current, 4, 'even narration that says the exact resume/nav phrases does not navigate — no speech parsing exists');
});

test('duplicate-nav suppression within the window (tool-call path)', () => {
  let now = 1000;
  const { session, p } = newPresenter({ cfg: { now: () => now } });   // deterministic clock
  p.start();
  session.fireToolCall('navigate_to_slide', { slide_num: 3 });
  assert.equal(p.current, 3);
  p.goTo(1, 'user'); now = 1500;            // back to 1, still within 3s of the slide-3 nav
  session.fireToolCall('navigate_to_slide', { slide_num: 3 });
  assert.equal(p.current, 1, 'repeat nav to slide 3 suppressed inside dupSuppressMs');
  now = 5000;                               // outside the window
  session.fireToolCall('navigate_to_slide', { slide_num: 3 });
  assert.equal(p.current, 3, 'allowed after the window');
});

test('tool call with reason:"resume" returns to the sequential point', () => {
  const { session, p } = newPresenter();
  p.start();
  p.goTo(2, 'user'); p.goTo(3, 'user');     // sequential reaches 3
  session.fireToolCall('navigate_to_slide', { slide_num: 5 });   // avatar jump — current=5, sequential stays 3
  session.fireToolCall('navigate_to_slide', { slide_num: 5, reason: 'resume' });   // slide_num ignored; resolved from _lastSequential
  assert.equal(p.current, 3, 'resume returns to the last sequential slide regardless of slide_num sent');
});

test('REGRESSION (issue #18): repeated resume navs are idempotent — the resume anchor is not mutated by a resume nav itself', () => {
  // The defect: _nav resolves reason:'resume' by reading _lastSequential, but goTo then
  // mutated _lastSequential as a side effect of THAT SAME navigation ('resume' !== 'avatar'),
  // so a second resume call (e.g. a duplicate the app failed to dedupe) resolved to a
  // DIFFERENT, further-advanced target instead of landing back on the same slide.
  const { session, p } = newPresenter();
  p.start();
  p.goTo(2, 'user'); p.goTo(3, 'user');     // sequential reaches 3
  session.fireToolCall('navigate_to_slide', { slide_num: 5 });   // avatar jump — current=5, sequential stays 3
  session.fireToolCall('navigate_to_slide', { slide_num: 5, reason: 'resume' });   // first resume: 5 -> 3
  assert.equal(p.current, 3, 'first resume returns to the sequential point');
  session.fireToolCall('navigate_to_slide', { slide_num: 5, reason: 'resume' });   // second resume: must also resolve to 3, not advance further
  assert.equal(p.current, 3, 'a second resume call resolves to the SAME target — it must not advance past the resume point');
});

test('goTo: DPP is sent BEFORE onSlideChange fires (grounding must never race ahead of state)', () => {
  // Real bug: an app's onSlideChange hook (e.g. a "[SLIDE CHANGE]" grounding speak()) must
  // see the DPP for the NEW slide already in flight — otherwise the brain answers against
  // a stale DPP while the UI has already rendered the new slide (the "thought it was on
  // slide 4 when it was actually on slide 1" desync).
  const seenDppSlideAtCallbackTime = [];
  const { p } = newPresenter({ onSlideChange: (n) => seenDppSlideAtCallbackTime.push(p.lastDppSlide) });
  p.start();
  p.goTo(3, 'user');
  assert.deepEqual(seenDppSlideAtCallbackTime, [3], 'lastDppSlide already reflects the new slide when onSlideChange fires');
});

test('session memory: saves progress; injects "welcome back" on next session; clearMemory wipes', () => {
  const storage = new MemStorage();
  let now = 10_000_000;
  // session 1: progress + a question
  { const { session, p } = newPresenter({ storage, cfg: { now: () => now } }); p.start(); p.goTo(2, 'user'); p.goTo(3, 'user'); session.emit('transcript', { type: 'user', text: 'what about margins?' }); }
  const saved = JSON.parse(storage.getItem('kaltura_presenter_memory'));
  assert.equal(saved.lastSlide, 3);
  assert.deepEqual(saved.covered, [1, 2, 3]);
  assert.deepEqual(saved.interests, ['what about margins?']);
  // session 2: memory present → first DPP carries memory.resume/covered/interests
  now += 2 * 3600 * 1000;                   // 2 hours later
  const { session: s2, p: p2 } = newPresenter({ storage, cfg: { now: () => now } });
  p2.start();
  const mem = s2.lastDpp.memory;
  assert.equal(mem.resume, 3);
  assert.equal(mem.hours_ago, 2);
  assert.deepEqual(mem.interests, ['what about margins?']);
  // memory injected ONCE — a later DPP omits it
  p2.goTo(2, 'user');
  assert.equal(s2.lastDpp.memory, null, 'memory injected once, not every turn');
  // clear control
  p2.clearMemory();
  assert.equal(storage.getItem('kaltura_presenter_memory'), null);
});

test('getters: covered / questions / lastNav track coverage, questions, and nav causality', () => {
  const { session, p } = newPresenter();
  p.start();
  // covered grows as we navigate; sorted ascending
  p.goTo(3, 'user');
  p.goTo(2, 'user');
  assert.deepEqual(p.covered, [1, 2, 3], 'covered is the sorted set of visited slides');
  // lastNav persists target + reason + at (causality)
  assert.equal(p.lastNav.target, 2);
  assert.equal(p.lastNav.reason, 'user');
  assert.equal(typeof p.lastNav.at, 'number');
  // an avatar-driven nav records reason:'avatar'
  session.fireToolCall('navigate_to_slide', { slide_num: 5 });
  assert.equal(p.current, 5);
  assert.equal(p.lastNav.target, 5);
  assert.equal(p.lastNav.reason, 'avatar', 'lastNav reason persists who drove the nav');
  // questions accumulate from user transcripts (read-only copy)
  session.emit('transcript', { type: 'user', text: 'what about churn?' });
  session.emit('transcript', { type: 'user', text: 'and margins?' });
  assert.deepEqual(p.questions, ['what about churn?', 'and margins?']);
  p.questions.push('mutation attempt');
  assert.equal(p.questions.length, 2, 'getter returns a defensive copy');
});

test('lastNav is null before any navigation', () => {
  const { p } = newPresenter();
  assert.equal(p.lastNav, null);
  p.start();
  assert.equal(p.lastNav, null, 'start() injects DPP but does not navigate');
});

test('memory: expired (>30d) is discarded on load', () => {
  const storage = new MemStorage();
  storage.setItem('kaltura_presenter_memory', JSON.stringify({ timestamp: 1, lastSlide: 4, covered: [1, 2, 3, 4], interests: [] }));
  const { session, p } = newPresenter({ storage });
  p.start();
  assert.equal(session.lastDpp.memory, null, 'stale memory not injected');
  assert.equal(storage.getItem('kaltura_presenter_memory'), null, 'and purged');
});

test('no storage → no memory, still functions', () => {
  const { session, p } = newPresenter();
  p.start();
  assert.equal(session.lastDpp.memory, null);
  assert.equal(p.memory, null);
});

test('DPP before connect is swallowed (caller injects after connect)', () => {
  const session = new FakeSession(); session.connected = false;
  const p = new Presenter({ session, slides: SLIDES });
  assert.doesNotThrow(() => p.start(), 'invalid_state from setDynamicPrompt is caught');
  assert.equal(session.dpps.length, 0);
});

test('deterministic nav: onToolCall("navigate_to_slide") drives goTo directly', () => {
  const { session, p } = newPresenter();
  p.start();
  session.fireToolCall('navigate_to_slide', { slide_num: 4 });
  assert.equal(p.current, 4);
  assert.equal(p.lastNav.reason, 'avatar');
  // duplicate suppression applies to the tool-call path too
  session.fireToolCall('navigate_to_slide', { slide_num: 4 });
  assert.equal(p.current, 4, 'no-op — already there');
});

test('deterministic nav: toolCallName:false disables onToolCall registration entirely (no other nav path exists)', () => {
  const session = new FakeSession();
  const p = new Presenter({ session, slides: SLIDES, toolCallName: false });
  p.start();
  assert.equal(session._toolCallHandlers.size, 0, 'no handler registered when disabled');
  session.emit('avatarStopTalking', { text: 'navigating to slide 3.' });
  assert.equal(p.current, 1, 'no speech-parsing fallback — narration never navigates');
});

test('extendDpp merges app-specific per-turn fields into every DPP', () => {
  const { session, p } = newPresenter({ cfg: { extendDpp: (slide, ctx) => ({ session_turn: ctx.current * 10 }) } });
  p.start();
  assert.equal(session.lastDpp.session_turn, 10);
  p.goTo(2, 'user');
  assert.equal(session.lastDpp.session_turn, 20);
});

test('extraMemory persists + restores app-specific memory fields', () => {
  const storage = new MemStorage();
  { const { p } = newPresenter({ storage, cfg: { extraMemory: () => ({ contact: 'a@b.com' }) } }); p.start(); p.goTo(2, 'user'); }
  const saved = JSON.parse(storage.getItem('kaltura_presenter_memory'));
  assert.equal(saved.contact, 'a@b.com');
});

test('reconnected: re-injects DPP for the current slide; cold reconnect (recovered:false) re-arms memory', () => {
  const storage = new MemStorage();
  let now = 10_000_000;
  { const { session, p } = newPresenter({ storage, cfg: { now: () => now } }); p.start(); p.goTo(3, 'user'); session.emit('transcript', { type: 'user', text: 'what about margins?' }); }
  now += 3600 * 1000;
  const { session, p } = newPresenter({ storage, cfg: { now: () => now } });
  p.start();
  p.goTo(2, 'user');
  const before = session.dpps.length;
  session.emit('reconnected', { recovered: true });
  assert.equal(session.dpps.length, before + 1, 'reconnected re-sends the DPP for the current slide');
  assert.equal(session.lastDpp.current_slide, 2);
  assert.equal(session.lastDpp.memory, null, 'warm reconnect does not re-arm memory');
  session.emit('reconnected', { recovered: false });
  assert.ok(session.lastDpp.memory, 'cold reconnect (recovered:false) re-arms the welcome-back memory injection');
  assert.equal(session.lastDpp.memory.resume, 3);
});

test('refreshDpp() re-sends the current slide DPP on demand', () => {
  const { session, p } = newPresenter();
  p.start();
  const before = session.dpps.length;
  p.refreshDpp();
  assert.equal(session.dpps.length, before + 1);
  assert.equal(session.lastDpp.current_slide, 1);
});

test('lastDppSlide tracks the slide of the last DPP that actually reached the session', () => {
  const session = new FakeSession(); session.connected = false;
  const p = new Presenter({ session, slides: SLIDES });
  assert.equal(p.lastDppSlide, 0, 'nothing sent yet — not connected');
  p.start();
  assert.equal(p.lastDppSlide, 0, 'start() swallowed (not connected) — still 0');
  session.connected = true;
  p.refreshDpp();
  assert.equal(p.lastDppSlide, 1);
  p.goTo(3, 'user');
  assert.equal(p.lastDppSlide, 3);
});

test('goTo: any non-"avatar" reason anchors the sequential resume point (app-specific reason taxonomy)', () => {
  const { session, p } = newPresenter({ slides: Array.from({ length: 10 }, (_, i) => ({ title: 'S' + (i + 1) })) });
  p.start();
  p.goTo(2, 'user_btn'); p.goTo(4, 'user_key');   // app-specific reasons, not Presenter's own 'user'
  assert.equal(p.lastNav.reason, 'user_key');
  p.goTo(8, 'avatar');                             // avatar jump — does NOT anchor resume
  session.fireToolCall('navigate_to_slide', { slide_num: 1, reason: 'resume' });
  assert.equal(p.current, 4, 'resume returns to the last non-avatar nav (user_key), not the avatar jump');
});

test('secondsOnCurrentSlide tracks time since the last nav (clock-injected)', () => {
  let now = 1000;
  const { p } = newPresenter({ cfg: { now: () => now } });
  p.start();
  assert.equal(p.secondsOnCurrentSlide, 0);
  now += 4500;
  assert.equal(p.secondsOnCurrentSlide, 5, 'rounds to the nearest second');
  p.goTo(2, 'user');
  assert.equal(p.secondsOnCurrentSlide, 0, 'resets on nav');
});

test('saveMemory() flushes on demand (e.g. beforeunload) without a nav/transcript event', () => {
  const storage = new MemStorage();
  const { p } = newPresenter({ storage });
  p.start(); p.goTo(3, 'user');
  storage.setItem('kaltura_presenter_memory', '');   // simulate nothing persisted since last write
  p.saveMemory();
  const saved = JSON.parse(storage.getItem('kaltura_presenter_memory'));
  assert.equal(saved.lastSlide, 3);
});

test('restoreMemory: inverse of extraMemory — remaps stored fields back into the first DPP memory block', () => {
  const storage = new MemStorage();
  let now = 10_000_000;
  { const { p } = newPresenter({ storage, cfg: { now: () => now, extraMemory: () => ({ contact: 'a@b.com', contactDeclined: true }) } }); p.start(); p.goTo(2, 'user'); }
  now += 3600 * 1000;
  const { session, p } = newPresenter({ storage, cfg: { now: () => now, restoreMemory: (m) => ({ contact: m.contact, contact_declined: m.contactDeclined || undefined }) } });
  p.start();
  assert.equal(session.lastDpp.memory.contact, 'a@b.com');
  assert.equal(session.lastDpp.memory.contact_declined, true);
});

test('recordQuestion: records a question from a non-ASR channel (e.g. typed chat) and re-injects DPP', () => {
  const storage = new MemStorage();
  const { session, p } = newPresenter({ storage });
  p.start();
  const before = session.dpps.length;
  p.recordQuestion('what about margins?');
  assert.deepEqual(p.questions, ['what about margins?']);
  assert.equal(session.dpps.length, before + 1, 'DPP re-injected');
  assert.equal(JSON.parse(storage.getItem('kaltura_presenter_memory')).interests[0], 'what about margins?');
  p.recordQuestion('');   // no-op on empty text
  assert.equal(p.questions.length, 1);
});

test('onTurnText fires with chunk + accumulated-full-text pairs', () => {
  const seen = [];
  const { session, p } = newPresenter({ cfg: { onTurnText: (chunk, full) => seen.push([chunk, full]) } });
  p.start();
  session.emit('turnStart', { isNewTurn: true, speechId: 'T1' });
  session.emit('brainSegment', { type: 'avatar', content: 'Hello ', speechId: 'T1' });
  session.emit('brainSegment', { type: 'avatar', content: 'there.', speechId: 'T1' });
  assert.deepEqual(seen, [['Hello ', 'Hello '], ['there.', 'Hello there.']]);
});

test('dppSlide: full-replace hook for decks whose shape does not match the default vocabulary', () => {
  const slides = [{ id: 1, body: 'Intro body', topics: ['a', 'b'] }, { id: 2, body: 'Second body', topics: ['c'] }];
  const { session, p } = newPresenter({ slides, cfg: { dppSlide: (slide, ctx) => ({ id: slide.id, body: slide.body, topics: slide.topics, at: ctx.current, of: ctx.total }) } });
  p.start();
  assert.deepEqual(session.lastDpp.slide, { id: 1, body: 'Intro body', topics: ['a', 'b'], at: 1, of: 2 });
  assert.equal(session.lastDpp.slide.title, undefined, 'default fields are NOT merged in — full replace');
});

test('dppSlide: ctx.content is the already visual-stripped slide.content, for convenience', () => {
  const slides = [{ title: 'Chart', content: { rev: 100, visual: 'chart.png' } }];
  let seenContent;
  const { p } = newPresenter({ slides, cfg: { dppSlide: (slide, ctx) => { seenContent = ctx.content; return { title: slide.title }; } } });
  p.start();
  assert.deepEqual(seenContent, { rev: 100 }, 'visual stripped before reaching the hook');
});

test('appendSlide: grows slides + total; the new slide is navigable', () => {
  const { session, p } = newPresenter();
  p.start();
  assert.equal(p.total, 5);
  const n = p.appendSlide({ title: 'New Slide', talking_points: ['fresh'] });
  assert.equal(n, 6);
  assert.equal(p.total, 6);
  assert.equal(p.slides.length, 6);
  p.goTo(6, 'avatar');
  assert.equal(p.current, 6);
  assert.equal(session.lastDpp.slide.title, 'New Slide');
});

test('appendSlide: does not navigate on its own', () => {
  const { p } = newPresenter();
  p.start();
  p.appendSlide({ title: 'New Slide' });
  assert.equal(p.current, 1, 'appendSlide alone never moves the deck');
});

test('oneNavPerTurn: a second, DIFFERENT avatar nav within the same turn is suppressed; a new turn reopens it', () => {
  const { session, p } = newPresenter({ cfg: { oneNavPerTurn: true } });
  p.start();
  session.emit('turnStart', { isNewTurn: true, speechId: 'r1' });
  session.fireToolCall('navigate_to_slide', { slide_num: 4 });
  assert.equal(p.current, 4, 'first nav this turn fires');
  session.fireToolCall('navigate_to_slide', { slide_num: 2 });
  assert.equal(p.current, 4, 'second, different nav target in the SAME turn is suppressed');
  session.emit('turnStart', { isNewTurn: true, speechId: 'r2' });
  session.fireToolCall('navigate_to_slide', { slide_num: 2 });
  assert.equal(p.current, 2, 'a new turn (new speechId) reopens the guard');
});

test('oneNavPerTurn: a nav arriving before any turnStart ever fires is never blocked (undefined vs null sentinel)', () => {
  const { p } = newPresenter({ cfg: { oneNavPerTurn: true } });
  p.start();
  const { session } = { session: p.session };
  session.fireToolCall('navigate_to_slide', { slide_num: 3 });
  assert.equal(p.current, 3, 'first-ever nav fires even with no turnStart yet observed');
});

test('oneNavPerTurn: default false — no suppression unless explicitly opted in', () => {
  const { session, p } = newPresenter();
  p.start();
  session.emit('turnStart', { isNewTurn: true, speechId: 'r1' });
  session.fireToolCall('navigate_to_slide', { slide_num: 4 });
  session.fireToolCall('navigate_to_slide', { slide_num: 2 });
  assert.equal(p.current, 2, 'without oneNavPerTurn, a second different nav in the same turn still fires');
});

test('destroy() removes every listener this Presenter registered on the session', () => {
  const { session, p } = newPresenter();
  p.start();
  const before = [...session._listeners.values()].reduce((n, set) => n + set.size, 0);
  assert.ok(before > 0, 'Presenter wired at least one session.on(...) listener');
  const toolCallHandlersBefore = session._toolCallHandlers.get('navigate_to_slide')?.length || 0;
  assert.equal(toolCallHandlersBefore, 1, 'Presenter registered its nav tool-call handler');

  p.destroy();

  const after = [...session._listeners.values()].reduce((n, set) => n + set.size, 0);
  assert.equal(after, 0, 'destroy() removed every session.on(...) listener');
  assert.equal(session._toolCallHandlers.get('navigate_to_slide')?.length || 0, 0, 'destroy() also removed the onToolCall handler');
});

test('destroy() is idempotent — safe to call more than once', () => {
  const { p } = newPresenter();
  p.start();
  p.destroy();
  assert.doesNotThrow(() => p.destroy());
});

test('destroy() stops a discarded Presenter from reacting to further session events (no collision with a replacement)', () => {
  const { session, p: oldPresenter } = newPresenter();
  oldPresenter.start();
  oldPresenter.goTo(3, 'user');
  oldPresenter.destroy();

  const dppCountBeforeReplacement = session.dpps.length;
  const replacement = new Presenter({ session, slides: SLIDES });
  replacement.start();

  // The discarded Presenter's own state must not move, and the session must not receive
  // a second, conflicting DPP from it after destroy() — only the replacement's.
  assert.equal(oldPresenter.current, 3, 'destroyed instance keeps its last state, but is inert going forward');
  session.fireToolCall('navigate_to_slide', { slide_num: 5 });
  assert.equal(oldPresenter.current, 3, 'destroyed Presenter never reacts to a tool call after destroy()');
  assert.equal(replacement.current, 5, 'only the replacement Presenter navigates');
  assert.ok(session.dpps.length > dppCountBeforeReplacement, 'the replacement still injects DPPs normally');
});

test('two independent Presenter instances (own sessions) run in parallel with zero shared state', () => {
  const a = newPresenter();
  const b = newPresenter();
  a.p.goTo(2, 'user');
  b.p.goTo(4, 'user');
  assert.equal(a.p.current, 2);
  assert.equal(b.p.current, 4);
  assert.notEqual(a.session, b.session, 'each Presenter owns its own session');
});

test('after destroy(), every public mutator is a silent no-op (never touches session/storage again)', () => {
  const storage = new MemStorage();
  const { session, p } = newPresenter({ storage });
  p.start();
  p.goTo(3, 'user');
  p.destroy();

  const dppsBefore = session.dpps.length;
  const totalBefore = p.total;
  const memoryBefore = storage.getItem('kaltura_presenter_memory');
  assert.ok(memoryBefore, 'goTo() before destroy() persisted memory as usual');

  p.start();
  p.goTo(2, 'user');
  p.refreshDpp();
  p.recordQuestion('are you still there?');
  p.saveMemory();
  p.clearMemory();
  const appended = p.appendSlide({ title: 'extra' });

  assert.equal(session.dpps.length, dppsBefore, 'no new DPP reached the session after destroy()');
  assert.equal(p.current, 3, 'goTo() after destroy() never moves the current slide');
  assert.equal(appended, totalBefore, 'appendSlide() after destroy() returns the unchanged total, never grows the deck');
  assert.equal(p.total, totalBefore, 'total is unchanged after destroy()');
  assert.equal(p.questions.length, 0, 'recordQuestion() after destroy() never records');
  assert.equal(storage.getItem('kaltura_presenter_memory'), memoryBefore, 'clearMemory() after destroy() never touches storage');
});

test('stop() is an alias for destroy()', () => {
  const { session, p } = newPresenter();
  p.start();
  const before = [...session._listeners.values()].reduce((n, set) => n + set.size, 0);
  assert.ok(before > 0);
  p.stop();
  const after = [...session._listeners.values()].reduce((n, set) => n + set.size, 0);
  assert.equal(after, 0, 'stop() removes listeners exactly like destroy()');
  const dppsBefore = session.dpps.length;
  p.goTo(2, 'user');
  assert.equal(session.dpps.length, dppsBefore, 'stop()-ed Presenter is inert, same as destroy()');
});

test('constructing a second live Presenter on the same session warns (forgot destroy()/stop())', () => {
  const session = new FakeSession();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    new Presenter({ session, slides: SLIDES });
    new Presenter({ session, slides: SLIDES });
    assert.equal(warnings.length, 1, 'a second live Presenter on the same session logs exactly one warning');
    assert.match(warnings[0], /already has one still live/);
  } finally {
    console.warn = originalWarn;
  }
});

test('no collision warning when the previous Presenter was destroy()-ed first', () => {
  const session = new FakeSession();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const a = new Presenter({ session, slides: SLIDES });
    a.destroy();
    new Presenter({ session, slides: SLIDES });
    assert.equal(warnings.length, 0, 'destroying the old instance first avoids the collision warning');
  } finally {
    console.warn = originalWarn;
  }
});

test('two live Presenters sharing one storage + the default memoryKey warn (silent memory collision otherwise)', () => {
  const storage = new MemStorage();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    new Presenter({ session: new FakeSession(), slides: SLIDES, storage });
    new Presenter({ session: new FakeSession(), slides: SLIDES, storage });
    assert.equal(warnings.length, 1, 'sharing storage + memoryKey across two live Presenters logs exactly one warning');
    assert.match(warnings[0], /memoryKey/);
  } finally {
    console.warn = originalWarn;
  }
});

test('a distinct memoryKey avoids the storage-collision warning', () => {
  const storage = new MemStorage();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    new Presenter({ session: new FakeSession(), slides: SLIDES, storage, memoryKey: 'deck_a' });
    new Presenter({ session: new FakeSession(), slides: SLIDES, storage, memoryKey: 'deck_b' });
    assert.equal(warnings.length, 0, 'distinct memoryKeys on the same storage never collide');
  } finally {
    console.warn = originalWarn;
  }
});

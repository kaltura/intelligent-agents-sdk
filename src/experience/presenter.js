/**
 * Presenter — the reusable "avatar guides through a deck/document" layer on top
 * of {@link KalturaAvatarSession}. It encapsulates the glue that EVERY deck app
 * otherwise rewrites by hand (proven in the earnings reference app):
 *
 *   - per-slide page-context building + injection via `session.setDynamicPrompt`,
 *     which delivers the payload as the thread-persistent `page_context` request
 *     var — the intellect's prompt must reference `{{page_context}}` (see the
 *     management page-context preset) or the brain never sees it
 *   - navigation via ONE deterministic, silent, idempotent mechanism:
 *     `session.onToolCall('navigate_to_slide', …)`. This is the only way the
 *     brain drives navigation — there is no speech-parsing fallback, so nav
 *     never depends on exact wording and never misfires on ordinary narration
 *     (a resume/back-nav phrase mentioned in passing can't be mistaken for a command)
 *   - slide-number word parsing ("twenty-four" → 24) for non-numeric tool args
 *   - session memory (where the user left off, what they covered/asked) for
 *     "welcome back" continuity — storage is injected (zero-dep, isomorphic);
 *     extensible with app-specific fields via `extraMemory`
 *   - duplicate-nav suppression + a sequential "resume" point
 *   - `extendContext` — a hook for per-turn, app-specific context fields (e.g.
 *     an engagement/session block) without the app reimplementing payload assembly
 *   - `onTurnText` — the SAME accumulated-per-turn text Presenter uses for its
 *     own nav parsing, exposed so an app's OTHER text-driven detectors (e.g.
 *     "the user asked for contact info", "the avatar is ending the session")
 *     can piggyback on one accumulator instead of duplicating it
 *   - reconnect resilience: a warm reconnect needs nothing from Presenter — the
 *     session re-sends its canonical request_vars map (page context included) on
 *     every rejoin. A cold reconnect (`recovered:false`) means the brain lost its
 *     context entirely, so Presenter re-arms the one-time "welcome back" memory
 *     injection and re-injects the current slide's context to carry the memory
 *     block onto the fresh thread — plus a public `refreshContext()` for any
 *     other app-driven re-grounding moment (e.g. resuming from a pause)
 *   - `restoreMemory` — the inverse of `extraMemory`: remaps app-specific stored
 *     memory fields back into the first context payload's `memory` block (e.g. a
 *     stored `contactDeclined` boolean → `memory.contact_declined`) — plus a public
 *     `saveMemory()` and a `secondsOnCurrentSlide` getter so an app never needs
 *     its own beforeunload flush or slide-entry timestamp
 *   - `slideContext` — a full-replace hook for the payload's `slide` sub-object,
 *     for decks whose slide shape doesn't match the default `{title, talking_points,
 *     category, content, narrator_guidance}` vocabulary
 *   - `appendSlide(slide)` — grow the deck at runtime (e.g. a `create_slide`
 *     client command), without the app reimplementing array/total bookkeeping
 *   - `oneNavPerTurn` — a brain-restart guard: suppresses a second, DIFFERENT
 *     avatar-driven nav target within the same turn (complements, and is
 *     distinct from, the same-target `dupSuppressMs` window) — exposed via the
 *     `navSuppressedThisTurn` getter so a sibling client command (e.g.
 *     `show_widget`) can tell its content was grounded in a nav that never landed
 *
 * The app supplies slides + a tiny renderer; the Presenter owns the conversation
 * wiring. Pure logic over an injected session + storage — fully unit-testable.
 * Presenter is an optional plugin: it is a separately-importable class with no
 * effect on `KalturaAvatarSession` or any other SDK surface until constructed.
 * The constructor wires several listeners onto `cfg.session` (an `Emitter`) —
 * call {@link Presenter#destroy} (aliased `stop()`, matching
 * `ExperienceRenderer#stop()`/`createNoiseSuppressor()`'s verb) to remove them
 * before constructing a new Presenter against the same still-connected session.
 * After `destroy()`, every public method on that instance is a no-op — it never
 * touches the session or storage again. Each Presenter instance is functionally
 * independent: no data or behavior flows between instances. The module DOES keep
 * two GC-safe `WeakSet`/`WeakMap` trackers (keyed by `session`/`storage`, exactly
 * like `noise-suppressor.js`'s `registeredContexts`) whose ONLY job is a
 * `console.warn` when a still-live instance's session or `{memoryKey, storage}`
 * pair collides with a new one — a misuse guard, not shared app state.
 *
 * @example
 * import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
 * import { Presenter } from '@kaltura/intelligent-agents/experience/presenter';
 * const session = new KalturaAvatarSession({ token, …appInit, videoEl, socketFactory });
 * const presenter = new Presenter({
 *   session,
 *   slides,                                  // [{ title, talking_points, category, content }]
 *   context: { financials, guidance },        // extra data merged into every context payload
 *   onSlideChange: (n, slide) => renderPdfPage(n),   // YOUR renderer
 *   storage: window.localStorage,             // optional → session memory
 * });
 * await session.connect();
 * await presenter.start();                    // injects slide-1 context (+ memory)
 */
import { parseSlideNumber } from './slidenav.js';
import { Teardown } from './teardown.js';

export { parseSlideNumber };

// Dev-time-only misuse guards (not app state — see the class doc comment above). Both are
// keyed by an externally-owned object, so they self-clear via GC and never leak, exactly like
// noise-suppressor.js's `registeredContexts` WeakSet. Neither is read anywhere except to decide
// whether to `console.warn`; no Presenter behavior branches on them.
const sessionsWithLivePresenter = new WeakSet();
const memoryKeysByStorage = new WeakMap();   // storage -> Set<memoryKey> currently claimed by a live Presenter

export class Presenter {
  /**
   * @param {object} cfg
   * @param {import('./session.js').KalturaAvatarSession} cfg.session
   * @param {Array<{title?:string,talking_points?:string[],category?:string,content?:object,narrator_guidance?:string}>} cfg.slides
   * @param {object} [cfg.context]              Extra data merged into every context payload (financials, guidance, …).
   * @param {(slideNum:number, slide:object, reason:string)=>void} [cfg.onSlideChange]  Your renderer (1-based).
   * @param {Storage|{getItem,setItem,removeItem}} [cfg.storage]  Where to persist session memory (e.g. localStorage). Omit to disable memory.
   * @param {string} [cfg.memoryKey]  Storage key for session memory (default `'kaltura_presenter_memory'` — a
   *   literal shared by every Presenter that doesn't override it). Pass a distinct key whenever more than one
   *   live Presenter shares one `storage` object (e.g. two decks on the same page), or they silently overwrite
   *   each other's memory; a live collision on the SAME default logs a `console.warn`.
   * @param {number} [cfg.dupSuppressMs]        Suppress a repeat nav to the same slide within this window (default 3000).
   * @param {(category?:string)=>{disclaimer_required?:boolean,non_gaap_cited?:boolean}} [cfg.metaFor]  Per-category context `meta` flags.
   * @param {string} [cfg.mode]                 Context payload `mode` tag (default 'presentation').
   * @param {() => number} [cfg.now]            Clock injection (defaults to Date.now) — for tests/determinism.
   * @param {string|false} [cfg.toolCallName]   Client-command name for navigation via `session.onToolCall` — the
   *   ONLY navigation mechanism (default `'navigate_to_slide'`, expects `{ slide_num, reason? }`; `reason:'resume'`
   *   marks the nav as returning to the sequential point rather than a fresh jump). Pass `false` to disable —
   *   there is no other nav path; Presenter then never navigates on its own.
   * @param {(slide:object, ctx:{current:number,total:number})=>object} [cfg.extendContext]  Merged into every context
   *   payload alongside `context` — for per-turn/dynamic fields (e.g. an engagement block) that `context` (static) can't express.
   * @param {(questions:string[])=>object} [cfg.extraMemory]  Extra fields to persist into session memory (e.g.
   *   `{contact}`), merged alongside the built-in `lastSlide`/`covered`/`interests` shape.
   * @param {(memory:object)=>object} [cfg.restoreMemory]  The inverse of `extraMemory` — maps the loaded memory
   *   object (the same shape `extraMemory` wrote) onto extra fields for the first context payload's `memory` block (e.g.
   *   `(m) => ({contact: m.contact, contact_declined: m.contactDeclined})`).
   * @param {(text:string, full:string)=>void} [cfg.onTurnText]  Fires with the per-turn accumulated avatar text
   *   (chunks joined as they stream in) — lets an app's own text-driven detectors (e.g. "the avatar said the
   *   closing line") reuse this accumulator instead of duplicating one. Not used for navigation.
   * @param {(slide:object, ctx:{current:number,total:number,content:object})=>object} [cfg.slideContext]  FULL REPLACE
   *   for the context payload's `slide` sub-object — use when your slide shape doesn't match the default
   *   `{title, talking_points, category, content, narrator_guidance}` vocabulary. `ctx.content` is the
   *   already visual-stripped `slide.content` object, for convenience. Omit to keep the default shape.
   * @param {boolean} [cfg.oneNavPerTurn]  Suppress a SECOND avatar-driven `navigate_to_slide` call within the
   *   SAME turn (`speechId`) — guards against a brain "restart" that fires two different nav targets in one
   *   response. Default `false`. Independent of `dupSuppressMs`, which only suppresses a repeat to the SAME
   *   target within a time window.
   * @param {boolean} [cfg.deckOutline]  Include a full-deck `{slide_num, title}[]` outline in every context payload
   *   (as `outline`), so the brain can resolve a topic → slide number mapping for `navigate_to_slide` without
   *   an integrator hand-rolling one into `BASE_DIRECTIVE`. Title collisions are disambiguated by appending the
   *   colliding slide's first talking point (or its slide number, if it has none). Stays correct after
   *   `appendSlide()` grows the deck — no invalidation needed. Default `false` (no `outline` key at all).
   * @param {(slide:object, ctx:{current:number,total:number})=>object} [cfg.extendDpp]  Legacy alias for `cfg.extendContext` — kept working, not documented elsewhere.
   * @param {(slide:object, ctx:{current:number,total:number,content:object})=>object} [cfg.dppSlide]  Legacy alias for `cfg.slideContext` — kept working, not documented elsewhere.
   */
  constructor(cfg) {
    if (!cfg?.session) throw new Error('Presenter needs { session }');
    if (!Array.isArray(cfg.slides) || !cfg.slides.length) throw new Error('Presenter needs a non-empty slides array');
    this._now = cfg.now || (() => Date.now());
    this.session = cfg.session;
    this.slides = cfg.slides;
    this.total = cfg.slides.length;
    this.context = cfg.context || {};
    this._onSlideChange = cfg.onSlideChange || (() => {});
    this._storage = cfg.storage || null;
    this._memoryKey = cfg.memoryKey || 'kaltura_presenter_memory';
    this._dupMs = cfg.dupSuppressMs ?? 3000;
    this._metaFor = cfg.metaFor || ((cat) => ({ disclaimer_required: cat === 'financial' || cat === 'legal', non_gaap_cited: cat === 'financial' }));
    this._mode = cfg.mode || 'presentation';
    this._toolCallName = cfg.toolCallName === false ? null : (cfg.toolCallName || 'navigate_to_slide');
    this._extendContext = cfg.extendContext || cfg.extendDpp || null;   // extendDpp: working legacy alias, undocumented
    this._extraMemory = cfg.extraMemory || null;
    this._restoreMemory = cfg.restoreMemory || null;
    this._onTurnText = cfg.onTurnText || null;
    this._slideContext = cfg.slideContext || cfg.dppSlide || null;   // dppSlide: working legacy alias, undocumented
    this._oneNavPerTurn = !!cfg.oneNavPerTurn;
    this._deckOutline = !!cfg.deckOutline;

    this.current = 1;
    this._lastSequential = 1;
    this._lastNavTarget = null; this._lastNavTime = 0;
    this._lastNav = null;   // {target, reason, at} — the most recent navigation (any source)
    this._slideEnteredAt = this._now();
    this._covered = new Set();
    this._questions = [];
    this._turnSpeechId = null; this._turnText = '';
    this._turnNavFiredFor = undefined;   // distinct from a legit `null` speechId — never blocks the very first nav
    this._navSuppressedThisTurn = false;   // true once oneNavPerTurn blocks a same-turn second nav target — see navSuppressedThisTurn
    this._memoryInjected = false;
    this._lastContextSlide = 0;   // slide number of the last context payload that actually reached the session (0 = none yet)
    this._memory = this._loadMemory();
    if (this._memory && typeof this._memory.lastSequential === 'number') this._lastSequential = this._memory.lastSequential;
    this._destroyed = false;

    /** Tracks every `session.on(...)` unsubscribe closure this instance registered — see {@link Teardown}. */
    this._teardown = new Teardown();
    this._warnOnCollision();
    this._wire();
  }

  /** Dev-time-only: warn on the two collisions this file's own tests exercise deliberately avoiding — a forgotten `destroy()`/`stop()` before a replacement Presenter shares a session, or two live Presenters sharing one `storage` + `memoryKey`. Never throws, never changes behavior. */
  _warnOnCollision() {
    if (typeof console === 'undefined') return;
    if (sessionsWithLivePresenter.has(this.session)) {
      console.warn('[Presenter] constructing a new Presenter against a session that already has one still live — call destroy() (or stop()) on the previous instance first, or both will keep injecting context, navigating, and saving memory against the same session.');
    }
    sessionsWithLivePresenter.add(this.session);
    if (this._storage) {
      const claimed = memoryKeysByStorage.get(this._storage) || new Set();
      if (claimed.has(this._memoryKey)) {
        console.warn(`[Presenter] another live Presenter is already using memoryKey "${this._memoryKey}" on this same storage — pass a distinct { memoryKey } to each, or they will overwrite each other's session memory.`);
      }
      claimed.add(this._memoryKey);
      memoryKeysByStorage.set(this._storage, claimed);
    }
  }

  /** Begin: mark slide 1 covered and inject its context (with memory on the first injection). No-op after {@link Presenter#destroy}. */
  async start() { if (this._destroyed) return; this._covered.add(this.current); this._injectContext(); }

  /**
   * Navigate the deck programmatically (user button/keyboard/TOC/autoplay — any
   * app-driven source). `reason` is passed straight through to the context payload's
   * `nav.why` field, so an app can pass its own taxonomy (e.g. `'user_btn'`/`'user_key'`/
   * `'autoplay'`) instead of being limited to Presenter's own `'user'`/`'avatar'`/
   * `'resume'`. `'avatar'` and `'resume'` both skip updating the sequential "resume"
   * point — every other reason anchors it. Excluding `'resume'` (as well as
   * `'avatar'`) is what makes `resume` idempotent: `_nav` RESOLVES a `'resume'`
   * target by READING `_lastSequential`, so if `goTo` let a `'resume'` nav WRITE
   * that same field, N resume calls in a row would each resolve to the previous
   * call's own landing spot instead of all landing on the same anchor.
   * @param {number} n @param {string} [reason]
   */
  goTo(n, reason = 'user') {
    if (this._destroyed) return;
    if (n < 1 || n > this.total || n === this.current) return;
    if ((reason !== 'avatar' && reason !== 'resume') || n === this.current + 1) this._lastSequential = n;
    const from = this.current;
    this.current = n; this._slideEnteredAt = this._now(); this._covered.add(n);
    this._lastNav = { target: n, reason, at: this._slideEnteredAt };   // causality: WHO drove this nav
    // Context goes out BEFORE onSlideChange fires — an app hook (e.g. a "[SLIDE CHANGE]" grounding
    // speak()) must never reach the brain ahead of the context for the slide it's grounding.
    this._injectContext({ from, why: reason });
    this._onSlideChange(n, this.slides[n - 1], reason);
    this._saveMemory();
  }

  /** The current slide object. */
  get slide() { return this.slides[this.current - 1]; }
  /** The memory object (or null) — exposes resume/covered/interests for UI. */
  get memory() { return this._memory; }

  /** The set of slide numbers covered this session (ascending) — coverage tracking for UI/analytics. @returns {number[]} */
  get covered() { return [...this._covered].sort((a, b) => a - b); }

  /** The user's questions captured this session (in order) — read-only copy. @returns {string[]} */
  get questions() { return [...this._questions]; }

  /**
   * The most recent navigation: `{target, reason, at}` (or null before any nav).
   * `reason` persists WHO drove it (`'user'`/`'avatar'`/`'resume'`) so a caller
   * can assert causality (e.g. that `goTo(N,'avatar')` came from the avatar).
   * @returns {{target:number, reason:string, at:number}|null}
   */
  get lastNav() { return this._lastNav ? { ...this._lastNav } : null; }

  /** The slide number of the last context payload that actually reached the session (0 = none yet — e.g. not connected). @returns {number} */
  get lastContextSlide() { return this._lastContextSlide; }

  /** Alias for {@link Presenter#lastContextSlide} (legacy name — kept working, not documented elsewhere). @returns {number} */
  get lastDppSlide() { return this._lastContextSlide; }

  /**
   * True once `oneNavPerTurn` has blocked a same-turn SECOND, different `navigate_to_slide`
   * target this turn (reset on the next `isNewTurn` turnStart). A sibling client command
   * (e.g. `show_widget`) fired later in the SAME turn has no way of knowing the deck never
   * actually reached the slide its content describes unless it checks this property first.
   * Always `false` when `oneNavPerTurn` is off. @returns {boolean}
   */
  get navSuppressedThisTurn() { return this._navSuppressedThisTurn; }

  /** Seconds spent on the current slide so far — for an engagement block in `extendContext`/analytics. @returns {number} */
  get secondsOnCurrentSlide() { return Math.round((this._now() - this._slideEnteredAt) / 1000); }

  /** Clear persisted session memory (the "start fresh" / GDPR control). No-op after {@link Presenter#destroy}. */
  clearMemory() { if (this._destroyed) return; this._memory = null; this._memoryInjected = false; this._covered = new Set([this.current]); this._questions = []; this._lastSequential = 1; try { this._storage?.removeItem?.(this._memoryKey); } catch { /* */ } }

  /** Re-send the current slide's context (e.g. after resume/pause, or any app-driven refresh outside a nav). No-op after {@link Presenter#destroy}. */
  refreshContext() { if (this._destroyed) return; this._injectContext(); }

  /** Alias for {@link Presenter#refreshContext} (legacy name — kept working, not documented elsewhere). */
  refreshDpp() { this.refreshContext(); }

  /** Flush session memory now (e.g. on `beforeunload`) — the same write `goTo`/`avatarStopTalking` already do. No-op after {@link Presenter#destroy}. */
  saveMemory() { if (this._destroyed) return; this._saveMemory(); }

  /**
   * Record a user question observed through a channel other than ASR (e.g. typed chat) —
   * the same bookkeeping the internal `transcript` (type:'user') handler does for spoken
   * questions, so an app with BOTH voice and typed input never needs its own question list.
   * No-op after {@link Presenter#destroy}.
   * @param {string} text
   */
  recordQuestion(text) { if (this._destroyed || !text) return; this._questions.push(text); this._injectContext(); this._saveMemory(); }

  /**
   * Append a runtime-generated slide (e.g. the brain's `create_slide` command) and grow
   * `total` to match. Does not navigate — call `goTo(this.total, reason)` after, if wanted.
   * No-op after {@link Presenter#destroy} (returns the unchanged `total`).
   * @param {object} slide @returns {number} the 1-based slide number just appended
   */
  appendSlide(slide) {
    if (this._destroyed) return this.total;
    this.slides.push(slide);
    this.total = this.slides.length;
    return this.total;
  }

  // ─────────────────────────── internals ───────────────────────────

  _wire() {
    const s = this.session;
    // Every listener registered below returns an unsubscribe closure, tracked via `_teardown`
    // so `destroy()` can remove all of them (Rule I-4; the same {@link Teardown} instance
    // `ExperienceRenderer` and `CaptionService` use).
    // The ONLY navigation mechanism: a client-command tool call. Deterministic (an explicit
    // slide number, never inferred from wording), silent (no speech is parsed or required),
    // and idempotent (routed through `_nav`'s duplicate suppression below).
    if (this._toolCallName && typeof s.onToolCall === 'function') {
      this._teardown.track(s.onToolCall(this._toolCallName, (args) => {
        const n = typeof args?.slide_num === 'number' ? args.slide_num : parseSlideNumber(args?.slide_num, this.total);
        if (!n) return;
        if (this._oneNavPerTurn) {
          if (this._turnNavFiredFor === this._turnSpeechId) { this._navSuppressedThisTurn = true; return; }   // second nav this turn — suppressed (brain restart guard)
          this._turnNavFiredFor = this._turnSpeechId;
        }
        this._nav(n, args?.reason === 'resume' ? 'resume' : 'avatar');
      }));
    }
    // Accumulate the avatar's spoken text per turn for `onTurnText` — an app-hook accumulator
    // only; Presenter itself never inspects this text (navigation never depends on wording).
    this._teardown.track(s.on('turnStart', (p) => { if (p?.isNewTurn) { this._turnSpeechId = p.speechId || null; this._turnText = ''; this._navSuppressedThisTurn = false; } }));
    this._teardown.track(s.on('transcript', (tr) => {
      if (tr?.type === 'user') { if (tr.text) { this._questions.push(tr.text); this._injectContext(); this._saveMemory(); } }
      else if (tr?.type === 'final') this._accumulate(tr.text, tr.speechId);   // clean sentence (generatingSpeech)
    }));
    this._teardown.track(s.on('brainSegment', (seg) => { if ((seg?.type === 'avatar' || seg?.type === 'avatar-filler') && seg.content) this._accumulate(seg.content, seg.speechId); }));
    this._teardown.track(s.on('avatarStopTalking', () => { this._turnSpeechId = null; this._turnText = ''; this._saveMemory(); }));
    this._teardown.track(s.on('interrupted', () => { this._turnSpeechId = null; this._turnText = ''; }));
    this._teardown.track(s.on('ended', () => this._saveMemory()));
    // A warm reconnect needs nothing here: the session re-sends its canonical request_vars map
    // (page context included) on every rejoin, and the recovered thread kept its history. A cold
    // reconnect (recovered:false) means the brain lost its context entirely — re-arm the one-time
    // "welcome back" memory injection and re-inject so the memory block reaches the fresh thread.
    this._teardown.track(s.on('reconnected', (p) => { if (p && p.recovered === false) { this._memoryInjected = false; this._injectContext(); } }));
  }

  /**
   * Tear down this instance: remove every listener it registered on `session` (Rule I-4)
   * AND mark it destroyed, so every other public mutator (`start`, `goTo`, `refreshContext`,
   * `recordQuestion`, `appendSlide`, `saveMemory`, `clearMemory`) becomes a silent no-op from
   * here on — the instance can no longer touch `session` or `storage`, period. Idempotent —
   * safe to call more than once, or on a Presenter that never fully wired. Call this (or its
   * alias {@link Presenter#stop}) before discarding a Presenter whose `session` stays connected
   * (e.g. swapping decks mid-session) — otherwise the old instance keeps injecting context/
   * navigating/saving memory alongside any replacement, and its listeners leak on the
   * session's `Emitter` for the session's lifetime. Terminal, unlike `ExperienceRenderer`'s
   * resumable `start()`/`stop()` pair — there is no `start()`-after-`destroy()` for a Presenter.
   * Does not disconnect `session` itself, and does not flush memory — call `saveMemory()`
   * first if you want the current state persisted.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    sessionsWithLivePresenter.delete(this.session);
    if (this._storage) { const claimed = memoryKeysByStorage.get(this._storage); if (claimed) claimed.delete(this._memoryKey); }
    this._teardown.run();
  }

  /** Alias for {@link Presenter#destroy} — matches the `stop()` verb `ExperienceRenderer`/`createNoiseSuppressor` use. */
  stop() { this.destroy(); }

  _accumulate(text, speechId) {
    if (!text) return;
    if (speechId && speechId !== this._turnSpeechId) { this._turnSpeechId = speechId; this._turnText = ''; }
    this._turnText += text;
    if (this._onTurnText) { try { this._onTurnText(text, this._turnText); } catch { /* app hook — never break Presenter */ } }
  }

  /**
   * Route a tool-driven nav through duplicate suppression, resolving `reason:'resume'` to the
   * sequential resume point. When `_lastSequential` already equals `current` there are two
   * distinct cases that look identical from that comparison alone: (a) a prior resume call
   * already landed here — repeating it must resolve to the SAME target (idempotent, a no-op),
   * or (b) there is genuinely nothing to resume from (the anchor was never displaced by an
   * avatar jump) — the documented fallback is to advance one slide (see
   * `KNOWLEDGE_BASE_PROMPT.md`'s "if nav.resume is null -> next slide in order"). Disambiguate
   * via `_lastNav`: only take the advance-by-one fallback when the immediately preceding nav
   * was NOT itself a resume landing on this same slide.
   * @param {number} target @param {'avatar'|'resume'} reason
   */
  _nav(target, reason) {
    if (reason === 'resume') {
      target = this._lastSequential !== this.current
        ? this._lastSequential
        : (this._lastNav?.reason === 'resume' ? this.current : this.current + 1);
    }
    if (target < 1 || target > this.total) return;
    const now = this._now();
    if (target === this._lastNavTarget && now - this._lastNavTime < this._dupMs) return;   // duplicate suppression
    this._lastNavTarget = target; this._lastNavTime = now;
    if (target === this.current) return;
    this.goTo(target, reason);
  }

  /**
   * Build the full-deck `{slide_num, title}[]` outline for the payload's `outline` (see `cfg.deckOutline`).
   * Reads `this.slides` fresh every call — no cache — so a runtime `appendSlide()` growth is
   * always reflected in the very next call with zero invalidation logic.
   * @returns {Array<{slide_num:number, title:string}>}
   */
  _buildOutline() {
    const titleCounts = new Map();
    for (const s of this.slides) titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1);
    return this.slides.map((s, i) => {
      const slide_num = i + 1;
      const collides = (titleCounts.get(s.title) || 0) > 1;
      if (!collides) return { slide_num, title: s.title };
      const disambiguator = s.talking_points?.[0];
      const title = disambiguator ? `${s.title} — ${disambiguator}` : `${s.title} (${slide_num})`;
      return { slide_num, title };
    });
  }

  /**
   * Build + send the current slide's context payload via `session.setDynamicPrompt`
   * (delivered as the thread-persistent `page_context` request var — each injection
   * overwrites the previous one whole). @param {{from?:number,why?:string}} [nav]
   */
  _injectContext(nav) {
    const slide = this.slide || {};
    const content = { ...(slide.content || {}) }; delete content.visual;
    const ctx = {
      v: '3', mode: this._mode,
      current_slide: this.current, total_slides: this.total,
      slide: this._slideContext
        ? this._slideContext(slide, { current: this.current, total: this.total, content })
        : { title: slide.title, talking_points: slide.talking_points, category: slide.category, content, narrator_guidance: slide.narrator_guidance || null },
      nav: nav ? { from: nav.from, why: nav.why, resume: (this._lastSequential !== this.current ? this._lastSequential : null) } : null,
      ...this.context,
      ...(this._extendContext ? this._extendContext(slide, { current: this.current, total: this.total }) : null),
      meta: this._metaFor(slide.category),
      memory: this._memoryForContext(),
    };
    if (this._deckOutline) ctx.outline = this._buildOutline();
    try { this.session.setDynamicPrompt(ctx); if (ctx.memory) this._memoryInjected = true; this._lastContextSlide = this.current; } catch { /* not connected yet — caller injects after connect */ }
    return ctx;
  }

  // ── session memory (storage injected; never assumes a browser) ──
  _loadMemory() {
    if (!this._storage) return null;
    try {
      const raw = this._storage.getItem(this._memoryKey); if (!raw) return null;
      const m = JSON.parse(raw);
      const maxAge = 30 * 24 * 3600 * 1000;
      if (!m?.timestamp || (this._now() - m.timestamp) > maxAge) { this._storage.removeItem(this._memoryKey); return null; }
      return m;
    } catch { return null; }
  }
  _saveMemory() {
    if (!this._storage) return;
    try {
      const interests = [...new Set(this._questions.map((q) => String(q).trim()).filter(Boolean))]
        .filter((q, i, a) => !a.slice(i + 1).some((o) => o.startsWith(q) || q.startsWith(o))).slice(-4);
      const extra = this._extraMemory ? this._extraMemory(this._questions) : null;
      this._storage.setItem(this._memoryKey, JSON.stringify({
        timestamp: this._now(), lastSlide: this.current, lastSequential: this._lastSequential, covered: [...this._covered], interests,
        ...extra,
      }));
    } catch { /* quota/unavailable — non-fatal */ }
  }
  _memoryForContext() {
    if (this._memoryInjected || !this._memory) return null;
    const m = this._memory, out = {};
    if (typeof m.lastSlide === 'number' && m.lastSlide > 1) out.resume = m.lastSlide;
    if ((m.covered || []).length) out.covered = m.covered;
    if ((m.interests || []).length) out.interests = m.interests;
    if (m.timestamp) out.hours_ago = Math.round((this._now() - m.timestamp) / 3600000);
    if (this._restoreMemory) { try { Object.assign(out, this._restoreMemory(m)); } catch { /* app hook — never break Presenter */ } }
    return Object.keys(out).length ? out : null;
  }
}

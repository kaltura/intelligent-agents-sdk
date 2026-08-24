/**
 * ExperienceRenderer — the GenUI segment→widget dispatch layer. It maps an
 * incoming `unisphere-tool` segment (by its NORMALIZED `runtimeName`) to a
 * framework-agnostic descriptor `{kind, data, runtime, _meta}` the host turns
 * into DOM. Zero-dep, no UI framework, never touches the DOM itself.
 *
 * DUAL-MODE (GenUI and client-side commands are client-build surfaces):
 *   - LIVE: `start()` subscribes to `session.on('brainSegment')` and feeds an
 *     internal {@link SegmentAssembler}; completed widgets are dispatched +
 *     pushed to `mount(descriptor)`. (The live avatar runtime hardcodes
 *     `force_experience:'avatar_only'`, so the socket emits structured widgets
 *     RARELY — WIRE-PROTOCOL §7; this path tolerates zero widgets.)
 *   - HEADLESS: `render(runtime, widget)` is called directly from a
 *     `Management.conversations.stream()` segment feed (the PRIMARY, reliable
 *     widget path). Same dispatch, same descriptor.
 *
 * HONESTY: `force_experience` is a HINT, not a guarantee — the renderer renders
 * WHATEVER `runtimeName` actually arrives. An unknown runtime yields a safe
 * `{kind:'unknown'}` fallback descriptor and fires `onUnhandled` — it NEVER
 * throws (the backend may add runtimes outside the nine first-class RUNTIMES;
 * those fall through here rather than being faked into a known kind).
 *
 * SECURITY: every default renderer routes untrusted LLM output through
 * `core/safety.js` (`safeText`/`safeUrl`) — no `innerHTML`, no raw href. A custom
 * renderer registered via {@link register} is the host's responsibility.
 */
import { meta } from '../../core/ids.js';
import { KalturaError } from '../../core/errors.js';
import { normalizeRuntime, parseWidget, RUNTIMES } from './parse.js';
import { SegmentAssembler } from './segments.js';
import { DEFAULT_RENDERERS } from './renderers/index.js';
import { mountWidget } from './renderers/mount.js';
import { Teardown } from '../teardown.js';

/**
 * Duck-type a DOM Element so `mount` can be a container, not just a callback.
 * @param {unknown} x
 * @returns {x is Element}
 */
function isElement(x) { return !!x && typeof x === 'object' && typeof (/** @type {any} */ (x)).appendChild === 'function' && (/** @type {any} */ (x)).nodeType === 1; }

export class ExperienceRenderer {
  /**
   * @param {object} [cfg]
   * @param {import('../session.js').KalturaAvatarSession} [cfg.session]  Live source — subscribed in {@link start}.
   * @param {((descriptor:object)=>void)|Element} [cfg.mount]  Host sink. A FUNCTION receives each descriptor (full control). An ELEMENT (or `cfg.target`) is rendered into automatically via {@link mountWidget} — the 2-line happy path.
   * @param {Element} [cfg.target]  Alias for an Element `mount` (container to render widgets into).
   * @param {(action:string, payload:object)=>void} [cfg.onAction]  Forwarded to `mountWidget` when rendering into an Element (followup/play/open/submit intents).
   * @param {Record<string,(model:Record<string,unknown>,ctx?:object)=>{kind:string,data:object}>} [cfg.renderers]  Extra/override renderers (by normalized runtime).
   * @param {boolean} [cfg.replace]  Ephemeral widgets re-render each turn — record only `last` (default false: accumulate). Also passed to `mountWidget` for Element mounts.
   * @param {boolean} [cfg.clearOnTurnStart]  LIVE mode: on the session's `turnStart` event, discard the in-flight buffer and `clear()` accumulated/`last` descriptors (default `true`). Set `false` for cross-turn persistence.
   * @param {number} [cfg.maxRendered]  Maximum number of descriptors to keep in `rendered` (default 100). The oldest entry is dropped when the cap is exceeded.
   * @param {(info:{runtime:string,runtimeName:string,widget:object})=>void} [cfg.onUnhandled]  Called for an unknown runtime (after the safe fallback descriptor is produced).
   * @param {{allow?:string[]}} [cfg.urlPolicy]  URL scheme allow-list passed to renderers (defense-in-depth alongside the server-side validator).
   * @param {string|number} [cfg.partnerId]  Stamped into the `_meta` receipt AND used by the media renderers to build real Kaltura thumbnail/player-embed URLs from an entryId.
   * @param {string|number} [cfg.uiConfId]  Optional Kaltura player uiConf id — lets `video-gallery` build a player-embed iframe URL for an entry.
   */
  constructor(cfg = {}) {
    const mountEl = isElement(cfg.mount) ? cfg.mount : (isElement(cfg.target) ? cfg.target : null);
    if (cfg.mount !== undefined && typeof cfg.mount !== 'function' && !mountEl) {
      throw new KalturaError({ type: 'about:blank', title: 'mount must be a function or Element', code: 'bad_request', detail: 'ExperienceRenderer { mount } must be a (descriptor)=>void function OR a DOM Element to render into.' });
    }
    if (cfg.onUnhandled !== undefined && typeof cfg.onUnhandled !== 'function') {
      throw new KalturaError({ type: 'about:blank', title: 'onUnhandled must be a function', code: 'bad_request', detail: 'ExperienceRenderer { onUnhandled } must be a function.' });
    }
    this.session = cfg.session || null;
    this._replace = !!cfg.replace;
    this._clearOnTurnStart = cfg.clearOnTurnStart !== undefined ? !!cfg.clearOnTurnStart : true;
    this._maxRendered = cfg.maxRendered !== undefined ? Number(cfg.maxRendered) : 100;
    // mount: an Element → auto-render via mountWidget; a function → call it; else none.
    this._mount = typeof cfg.mount === 'function' ? cfg.mount
      : (mountEl ? (descriptor) => mountWidget(descriptor, mountEl, { onAction: cfg.onAction, replace: this._replace }) : null);
    this._onUnhandled = typeof cfg.onUnhandled === 'function' ? cfg.onUnhandled : null;
    this._urlPolicy = cfg.urlPolicy || {};
    this._partnerId = cfg.partnerId !== undefined ? String(cfg.partnerId)
      : (this.session && this.session.partnerId != null ? String(this.session.partnerId) : undefined);
    // Optional Kaltura player uiConf id — lets video-gallery build a player-embed URL.
    // (No session-side fallback: KalturaAvatarSession never carries a uiConfId.)
    this._uiConfId = cfg.uiConfId !== undefined ? String(cfg.uiConfId) : undefined;

    /** @type {Map<string, (model:Record<string,unknown>, ctx?:object)=>{kind:string,data:object}>} */
    this._registry = new Map(Object.entries(DEFAULT_RENDERERS));
    if (cfg.renderers && typeof cfg.renderers === 'object') {
      for (const [name, fn] of Object.entries(cfg.renderers)) this.register(name, fn);
    }

    /** @type {object[]} */
    this._rendered = [];
    /** @type {object|null} */
    this._last = null;

    this._assembler = new SegmentAssembler({
      onWidget: (w) => this._renderWidget(w),
      onMalformed: (info) => this._renderMalformed(info),
    });
    /** Tracks every `session.on(...)` unsubscribe closure this instance registered — see {@link Teardown}. */
    this._teardown = new Teardown();
    this._started = false;
  }

  /**
   * Register (or override) a renderer for a runtime. The name is normalized
   * (`flashcards-tool` and `flashcards` are the same key). Returns `this` for
   * chaining. Throws `bad_request` (BEFORE any use) on a bad name/fn.
   * @param {string} runtimeName @param {(model:Record<string,unknown>, ctx?:object)=>{kind:string,data:object}} fn
   */
  register(runtimeName, fn) {
    const runtime = normalizeRuntime(runtimeName);
    if (!runtime) {
      throw new KalturaError({ type: 'about:blank', title: 'runtime name required', code: 'bad_request', detail: `register() needs a non-empty runtime name, got ${JSON.stringify(runtimeName)}.` });
    }
    if (typeof fn !== 'function') {
      throw new KalturaError({ type: 'about:blank', title: 'renderer must be a function', code: 'bad_request', detail: `register('${runtime}', fn) — fn must be a (model, ctx) => {kind, data} function.` });
    }
    this._registry.set(runtime, fn);
    return this;
  }

  /** True if a renderer (default or custom) is registered for the (normalized) runtime. @param {string} runtimeName */
  has(runtimeName) { return this._registry.has(normalizeRuntime(runtimeName)); }

  /** The list of runtimes this renderer currently dispatches (sorted). */
  get runtimes() { return [...this._registry.keys()].sort(); }

  /**
   * Begin LIVE mode: subscribe to the session's `brainSegment`/turn-end events
   * and feed the assembler. No-op (and harmless) if no session was provided.
   * Idempotent. Returns `this`.
   */
  start() {
    if (this._started || !this.session || typeof this.session.on !== 'function') { this._started = true; return this; }
    this._started = true;
    const s = this.session;
    this._teardown.track(s.on('brainSegment', (seg) => { try { this._assembler.ingest(seg); } catch { /* never break the session */ } }));
    this._teardown.track(s.on('turnEnd', (p) => { try { this._assembler.onTurnEnd(p && p.speechId); } catch { /* */ } }));
    this._teardown.track(s.on('avatarStopTalking', () => { try { this._assembler.flush(); } catch { /* */ } }));
    this._teardown.track(s.on('interrupted', () => this._assembler.reset()));
    if (this._clearOnTurnStart) {
      // Gate on isNewTurn like every other turnStart consumer (presenter.js, avatar-session.js) —
      // a duplicate turn (isNewTurn:false, e.g. speak()'s barge-in tap-to-talk race) must not wipe
      // an already-rendered widget out from under the viewer mid-turn.
      this._teardown.track(s.on('turnStart', (p) => { if (p?.isNewTurn) { this._assembler.reset(); this.clear(); } }));
    }
    return this;
  }

  /** Stop LIVE mode: unsubscribe + flush any in-flight buffer. Returns `this`. */
  stop() {
    this._teardown.run();
    try { this._assembler.flush('stop'); } catch { /* */ }
    this._started = false;
    return this;
  }

  /**
   * Dispatch a single widget by runtime → descriptor. The HEADLESS entry point
   * (call it from a `conversations.stream()` segment feed) and the internal sink
   * for LIVE-assembled widgets.
   *
   * Accepts either `(runtimeName, widget)` where `widget` is the body
   * (object/string content), OR a single segment object `(segment)` (the live
   * `{metadata:{runtimeName}, content}` shape). NEVER throws — an unknown
   * runtime returns the safe fallback descriptor.
   * @param {string|object} runtimeNameOrSegment
   * @param {unknown} [widget]
   * @returns {{kind:string, data:object, runtime:string, runtimeName:string, _meta:object}}
   */
  render(runtimeNameOrSegment, widget) {
    let parsed;
    if (typeof runtimeNameOrSegment === 'string') {
      parsed = parseWidget({ metadata: { runtimeName: runtimeNameOrSegment }, content: widget });
    } else {
      parsed = parseWidget(runtimeNameOrSegment);
    }
    return this._renderWidget(parsed);
  }

  /** Drop all accumulated descriptors (`replace:false` accumulation reset). Returns `this`. */
  clear() { this._rendered = []; this._last = null; return this; }

  /** The most recently rendered descriptor (or null). */
  get last() { return this._last; }

  /** All accumulated descriptors (empty when `replace:true`). */
  get rendered() { return this._rendered; }

  // ─────────────────────────── internals ───────────────────────────

  /**
   * @param {{runtime?:string, runtimeName?:string, model?:Record<string,unknown>, speechId?:(string|null)}} parsed
   * @returns {{kind:string, data:object, runtime:string, runtimeName:string, _meta:object}}
   */
  _renderWidget(parsed) {
    const runtime = parsed.runtime || normalizeRuntime(parsed.runtimeName);
    const model = parsed.model || {};
    // partnerId + player config let the media renderers build REAL Kaltura
    // thumbnail/player-embed URLs from an entryId (see core/kaltura-media.js).
    const ctx = { urlPolicy: this._urlPolicy, runtime, partnerId: this._partnerId, uiConfId: this._uiConfId };
    const fn = this._registry.get(runtime);

    /** @type {{kind:string, data:object}} */
    let base;
    if (fn) {
      try {
        const out = fn(model, ctx);
        base = (out && typeof out === 'object' && typeof out.kind === 'string')
          ? out
          : { kind: runtime || 'unknown', data: out && typeof out === 'object' ? out : {} };
      } catch (err) {
        // A custom/host renderer threw — degrade to a typed error descriptor, never throw.
        base = { kind: 'error', data: { runtime, message: String((err && err.message) || err) } };
      }
    } else {
      // Unknown runtime → safe fallback. Preserve the raw model.
      base = { kind: 'unknown', data: { runtime: runtime || null, model } };
      if (this._onUnhandled) {
        try { this._onUnhandled({ runtime, runtimeName: parsed.runtimeName || '', widget: model }); } catch { /* */ }
      }
    }

    const descriptor = {
      ...base,
      runtime: runtime || '',
      runtimeName: parsed.runtimeName || '',
      _meta: meta({
        partnerId: this._partnerId,
        source: 'experience/genui',
        scope: 'conversation (geniegpcid, entitlement ON)',
        // `known`: this instance has a renderer for it (a registered 10th runtime is known too).
        // `firstClass`: one of the nine built-in GenUI runtimes.
        known: this._registry.has(runtime),
        firstClass: RUNTIMES.includes(runtime),
      }),
    };
    return this._recordAndMount(descriptor);
  }

  /**
   * A widget was interrupted before it finished streaming ({@link SegmentAssembler}'s
   * `onMalformed`, issue #26) — reuses the SAME typed fallback shape `_renderWidget`
   * already produces for a throwing custom renderer (`{kind:'error', data:{runtime,
   * message}}`), so a host handles both cases identically.
   * @param {{runtime:string,runtimeName:string,speechId:(string|null),reason:string,message:string}} info
   */
  _renderMalformed(info) {
    const descriptor = {
      kind: 'error',
      data: { runtime: info.runtime, message: info.message },
      runtime: info.runtime || '',
      runtimeName: info.runtimeName || '',
      _meta: meta({
        partnerId: this._partnerId,
        source: 'experience/genui',
        scope: 'conversation (geniegpcid, entitlement ON)',
        known: this._registry.has(info.runtime),
        firstClass: RUNTIMES.includes(info.runtime),
      }),
    };
    return this._recordAndMount(descriptor);
  }

  /** Record `descriptor` into `rendered`/`last` (respecting `replace`) and push it to `mount`, if any. @param {object} descriptor */
  _recordAndMount(descriptor) {
    this._last = descriptor;
    if (this._replace) this._rendered = [descriptor];
    else { this._rendered.push(descriptor); if (this._rendered.length > this._maxRendered) this._rendered.shift(); }
    if (this._mount) { try { this._mount(descriptor); } catch { /* a throwing host sink never breaks render */ } }
    return descriptor;
  }
}

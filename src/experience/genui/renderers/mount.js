/**
 * mountWidget — the zero-dependency, framework-agnostic DOM renderer for a GenUI
 * descriptor (the `{kind, data}` an `ExperienceRenderer` produces). It is the
 * "last mile" between a descriptor and a safe, accessible DOM subtree, built in
 * one call instead of every app reimplementing it.
 *
 * CONTRACT (mirrors `renderSafeLink`):
 *   - Isomorphic: returns `null` when there's no DOM (`typeof document === 'undefined'`).
 *   - NEVER uses `innerHTML`. Every text node is `textContent`; every link/image goes
 *     through scheme-checked DOM construction (`renderSafeLink` / `safeImg`). So even a
 *     HAND-BUILT (not SDK-parsed) descriptor cannot inject markup or a `javascript:` href.
 *   - Pure structure, ZERO shipped styling: it emits a stable `kgenui` / `kgenui__*`
 *     class contract (BEM-ish) for the host to theme. No colors, no CSS.
 *   - Accessible by construction: semantic elements, ARIA roles/labels, real
 *     `<button>`/`<label>`/`<input>`, keyboard-operable flashcards/chips/forms,
 *     `alt` on every image, a "(opens in a new tab)" cue on external links.
 *
 * INTERACTIVITY: pass `opts.onAction(action, payload)` to receive user intent the
 * widget can't fulfil itself — the host wires these to the session:
 *   - 'followup'  {question}            → e.g. session.speak(question)
 *   - 'play'      {entryId?, url?, id?} → host plays the clip / opens the slide
 *   - 'open'      {url}                  → a link/source/content card was activated
 *   - 'submit'    {values}              → a structured-data form was submitted (→ session.submitStructuredDataForm)
 *   - 'answer'    {questionId, variant, correct, value, explanation, optionId?}
 *                                        → a `graded-question` was answered; `correct` is
 *                                          `boolean|null` (`null` = no answer key authored, ungraded)
 *
 * @module
 */
import { safeText, safeUrl, renderSafeLink } from '../../../core/safety.js';
import { EMBED_HOSTS } from '../../../core/kaltura-media.js';
import { el, cssToken } from './dom-helpers.js';
import { renderMarkdown } from './markdown.js';

/** @typedef {{kind:string, data:object, runtime?:string, runtimeName?:string, category?:string}} GenUIDescriptor */

/**
 * Render a GenUI descriptor into `target`. Returns the mounted root `<section>`
 * (or `null` outside a browser). Never throws on a malformed descriptor.
 *
 * @param {GenUIDescriptor} descriptor  A descriptor from `ExperienceRenderer` (or a hand-built one).
 * @param {Element} target              The host container to append (or replace) into.
 * @param {{replace?:boolean, onAction?:(action:string, payload:object)=>void, onMount?:(root:Element, descriptor:GenUIDescriptor)=>void, markdown?:boolean}} [opts]
 *   `replace` clears `target` first; `onAction` receives interaction intents (see module doc).
 *   `onMount(root, descriptor)` fires AFTER the safe subtree is built + appended — a
 *   host-enhancement seam for a registered custom `kind` (e.g. syntax-highlighting a
 *   code block a custom renderer produced). The safe default DOM is already present,
 *   so a no-op `onMount` (or a thrown one) just leaves the safe render — progressive
 *   enhancement, never a regression. Crash-safe.
 * @returns {Element|null} The mounted root, or `null` if there was no DOM to mount into,
 *   OR the builder appended nothing (e.g. a `summary` with no title/text/bullets) — a
 *   caller that opened a region/overlay in anticipation of content should treat `null`
 *   as "nothing to show" and close it rather than leave a visibly empty box.
 */
export function mountWidget(descriptor, target, opts = {}) {
  if (typeof document === 'undefined') return null;          // isomorphic: no-op without a DOM
  const d = (descriptor && typeof descriptor === 'object') ? descriptor : { kind: 'unknown', data: {} };
  const data = (d.data && typeof d.data === 'object') ? d.data : {};
  const kind = typeof d.kind === 'string' && d.kind ? d.kind : 'unknown';
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : () => {};

  const root = el('section', 'kgenui kgenui--' + cssToken(kind));
  root.setAttribute('role', 'group');
  const label = safeText(data.title || titleCase(kind), 300);
  if (label) root.setAttribute('aria-label', label);
  root.dataset.kind = kind;
  if (d.category) root.dataset.category = String(d.category);
  if (d.runtime) root.dataset.runtime = String(d.runtime);

  try { (BUILDERS[kind] || buildUnknown)(root, data, onAction, { markdown: !!opts.markdown }); }
  catch (err) { root.replaceChildren(); buildError(root, { message: String((err && err.message) || err) }); }

  if (!root.children.length) {
    // Nothing was appended (e.g. an empty summary: no title, no text, no bullets) — mounting
    // an empty <section> would just be a blank box. Still honor `replace` so a caller that
    // expected fresh content doesn't have to separately clear stale content itself.
    if (target && opts.replace && typeof target.replaceChildren === 'function') target.replaceChildren();
    return null;
  }

  if (target && typeof target.appendChild === 'function') {
    if (opts.replace && typeof target.replaceChildren === 'function') target.replaceChildren();
    target.appendChild(root);
  }
  // Progressive-enhancement seam: the safe DOM is already mounted; a host may upgrade it.
  if (typeof opts.onMount === 'function') { try { opts.onMount(root, d); } catch { /* enhancement is best-effort; safe render stays */ } }
  return root;
}

/* ─────────────── per-kind builders (append into the root) ─────────────── */

const BUILDERS = {
  summary(root, data, _onAction, renderOpts) {
    titleEl(root, data.title);
    if (data.summary) {
      // Opt-in: render markdown-in-plain-text (tables, bold, links, …) as
      // real DOM. Default stays flat escaped text so no existing app regresses.
      if (renderOpts && renderOpts.markdown) root.appendChild(renderMarkdown(data.summary));
      else root.appendChild(el('p', 'kgenui__text', safeText(data.summary, 8000)));
    }
    listEl(root, asArray(data.bullets), (b) => el('li', 'kgenui__bullet', safeText(b, 1000)));
  },

  flashcards(root, data) {
    titleEl(root, data.title);
    const list = el('ul', 'kgenui__list');
    list.setAttribute('role', 'list');
    for (const c of asArray(data.cards)) {
      const front = safeText(c && c.front, 1000);
      const back = safeText(c && c.back, 4000);
      const li = el('li', 'kgenui__card');
      // A flip toggle: a real button so it's focusable + keyboard-operable.
      const btn = el('button', 'kgenui__flip', front);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'Flashcard: ' + safeText((c && c.label) || front, 120));
      const answer = el('span', 'kgenui__back', back);
      answer.hidden = true;
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', open ? 'false' : 'true');
        answer.hidden = open;
      });
      li.append(btn, answer);
      list.appendChild(li);
    }
    root.appendChild(list);
  },

  followups(root, data, onAction) {
    const list = el('ul', 'kgenui__list kgenui__chips');
    list.setAttribute('role', 'list');
    for (const q of asArray(data.questions)) {
      const text = safeText(q, 500);
      if (!text) continue;
      const li = el('li');
      const btn = el('button', 'kgenui__chip', text);
      btn.type = 'button';
      btn.addEventListener('click', () => onAction('followup', { question: text }));
      li.appendChild(btn);
      list.appendChild(li);
    }
    root.appendChild(list);
  },

  sources(root, data, onAction) {
    const list = el('ul', 'kgenui__list');
    list.setAttribute('role', 'list');
    for (const s of asArray(data.sources)) {
      const li = el('li', 'kgenui__source');
      const a = link(s && s.url, safeText((s && s.title) || (s && s.url), 500), onAction);
      li.appendChild(a || el('span', 'kgenui__title', safeText(s && s.title, 500)));
      if (s && Number.isFinite(s.score)) li.appendChild(el('span', 'kgenui__score', String(s.score)));
      if (s && s.snippet) li.appendChild(el('p', 'kgenui__snippet', safeText(s.snippet, 2000)));
      list.appendChild(li);
    }
    root.appendChild(list);
  },

  'show-link'(root, data, onAction) {
    // Drop entirely when the descriptor flagged the URL unsafe — no dead `#` link.
    if (data.safe === false) { root.appendChild(el('p', 'kgenui__muted', 'Link unavailable.')); return; }
    const a = link(data.url, safeText(data.label || data.url, 300), onAction);
    if (a) root.appendChild(a);
    if (data.description) root.appendChild(el('p', 'kgenui__text', safeText(data.description, 2000)));
  },

  'external-video'(root, data, onAction) {
    titleEl(root, data.title);
    // Real player first: an embeddable host (YouTube/Vimeo) → an actual <iframe>.
    const frame = data.embedUrl ? safeIframe(data.embedUrl, safeText(data.title || 'Video', 300)) : null;
    if (frame) { root.appendChild(frame); }
    else if (data.safe !== false && data.url) {
      // Not embeddable → poster (if any) + a scheme-checked link as fallback.
      if (data.poster) { const img = safeImg(data.poster, safeText(data.title || 'video', 300)); if (img) root.appendChild(img); }
      const a = link(data.url, safeText(data.title || 'Play video', 300), onAction);
      if (a) root.appendChild(a);
    } else { root.appendChild(el('p', 'kgenui__muted', 'Video unavailable.')); }
    if (data.provider) root.appendChild(el('span', 'kgenui__meta', safeText(data.provider, 100)));
    if (data.description) root.appendChild(el('p', 'kgenui__text', safeText(data.description, 2000)));
  },

  'video-gallery'(root, data, onAction) {
    titleEl(root, data.title);
    // A shared inline player surface: clicking a clip mounts its Kaltura player here.
    const stage = el('div', 'kgenui__player');
    stage.hidden = true;
    gallery(root, asArray(data.videos), (v) => {
      const card = el('li', 'kgenui__card');
      const img = safeImg(v && v.thumbnailUrl, safeText((v && v.alt) || (v && v.title), 300));
      // The thumbnail plays the clip — a focusable button wrapping the image.
      const btn = el('button', 'kgenui__play');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Play: ' + safeText((v && v.title) || (v && v.entryId), 300));
      if (img) btn.appendChild(img);
      else btn.appendChild(el('span', 'kgenui__play-glyph', '▶'));
      btn.addEventListener('click', () => {
        // Real player inline when we have an embed URL; always surface the intent too.
        const frame = (v && v.embedUrl) ? safeIframe(v.embedUrl, safeText((v && v.title) || 'Video', 300)) : null;
        if (frame) { stage.replaceChildren(frame); stage.hidden = false; stage.scrollIntoView?.({ block: 'nearest' }); }
        onAction('play', { entryId: v && v.entryId, url: v && v.url, embedUrl: v && v.embedUrl });
      });
      card.appendChild(btn);
      if (v && v.title) card.appendChild(el('span', 'kgenui__title', safeText(v.title, 500)));
      if (v && v.duration) card.appendChild(el('span', 'kgenui__meta', safeText(v.duration, 40)));
      return card;
    });
    root.appendChild(stage);
  },

  'content-gallery'(root, data, onAction) {
    titleEl(root, data.title);
    gallery(root, asArray(data.items), (it) => {
      const card = el('li', 'kgenui__card');
      const img = safeImg(it && it.imageUrl, safeText((it && it.alt) || (it && it.title), 300));
      if (img) card.appendChild(img);
      if (it && it.title) card.appendChild(el('span', 'kgenui__title', safeText(it.title, 500)));
      if (it && it.description) card.appendChild(el('p', 'kgenui__text', safeText(it.description, 2000)));
      if (it && it.url) { const a = link(it.url, safeText(it.title || 'Open', 300), onAction); if (a) card.appendChild(a); }
      else if (it && it.id) { card.dataset.id = String(it.id); }
      return card;
    });
  },

  'user-properties-form'(root, data, onAction) {
    titleEl(root, data.title);
    const form = el('form', 'kgenui__form');
    const values = {};
    for (const f of asArray(data.fields)) {
      if (!f || !f.key) continue;
      const id = 'kgenui-f-' + cssToken(String(f.key));
      const wrap = el('div', 'kgenui__field');
      const lbl = el('label', 'kgenui__label', safeText(f.label || f.key, 300));
      lbl.htmlFor = id;
      const input = el('input', 'kgenui__input');
      input.id = id;
      input.name = safeText(f.key, 200);
      input.type = htmlInputType(f.type);
      const im = inputMode(f.type); if (im) input.inputMode = im;
      if (f.type === 'bool') { input.checked = f.knownValue === 'true' || f.knownValue === true; }
      else if (f.knownValue) input.value = safeText(f.knownValue, 1000);
      if (f.required) input.setAttribute('aria-required', 'true');
      wrap.append(lbl, input);
      if (f.description) {
        const help = el('span', 'kgenui__help', safeText(f.description, 500));
        help.id = id + '-help';
        input.setAttribute('aria-describedby', help.id);
        wrap.appendChild(help);
      }
      input.addEventListener('input', () => { values[input.name] = f.type === 'bool' ? input.checked : input.value; });
      values[input.name] = f.type === 'bool' ? input.checked : input.value;
      form.appendChild(wrap);
    }
    const submit = el('button', 'kgenui__submit', 'Submit');
    submit.type = 'submit';
    form.appendChild(submit);
    form.addEventListener('submit', (e) => { if (e && e.preventDefault) e.preventDefault(); onAction('submit', { values: { ...values } }); });
    root.appendChild(form);
  },

  // NOT one of the nine backend runtimes; reached only when a host
  // registers this kind via `new ExperienceRenderer({ renderers: {...} })` or
  // `.register(...)`. Grading is client-side: the answer key travels in `data`
  // itself, same trust model as every other GenUI widget's model data — this is
  // a comprehension-check primitive, not a tamper-proof assessment. All text is
  // re-sanitized here (never trusts the renderer already did it), matching every
  // other builder's contract for hand-built descriptors.
  'graded-question'(root, data, onAction) {
    const prompt = safeText(data.prompt, 2000);
    if (prompt) root.appendChild(el('p', 'kgenui__prompt', prompt));

    const options = asArray(data.options).slice(0, MAX_GQ_OPTIONS).map((o) => {
      const src = (o && typeof o === 'object') ? o : {};
      return { id: safeText(src.id, 200) || 'opt', text: safeText(src.text, 500) };
    }).filter((o) => o.text);
    const variant = options.length > 0 ? 'choice' : 'text';
    const questionId = safeText(data.questionId, 200) || 'q';
    const explanation = safeText(data.explanation, 2000);
    const correctOptionId = typeof data.correctOptionId === 'string' ? safeText(data.correctOptionId, 200) : null;
    const acceptedAnswers = asArray(data.acceptedAnswers).map((a) => safeText(a, 500)).filter(Boolean);

    // role="status" must be present in the DOM before its text changes — an
    // AT-hidden-until-reveal element toggled to visible+populated in the same
    // tick is a common pattern that many screen readers fail to announce.
    // So this stays mounted and empty, never `.hidden`, from the start.
    const feedback = el('p', 'kgenui__feedback');
    feedback.setAttribute('role', 'status');
    const explanationEl = el('p', 'kgenui__explanation', explanation);
    explanationEl.hidden = true;

    // Per-mount closure state — never module-level, so two
    // mounted graded-question widgets in one process never share an answer.
    let answered = false;
    const reveal = (correct, value, optionId) => {
      if (answered) return;   // one answer per mount
      answered = true;
      feedback.textContent = correct === true ? 'Correct.' : correct === false ? 'Not quite.' : 'Answer recorded.';
      feedback.classList.add('kgenui__feedback--' + (correct === true ? 'correct' : correct === false ? 'incorrect' : 'neutral'));
      if (explanation) explanationEl.hidden = false;
      const payload = { questionId, variant, correct, value, explanation };
      if (optionId != null) payload.optionId = optionId;
      onAction('answer', payload);
    };

    if (variant === 'choice') {
      let selectedId = null;
      const inputs = [];
      const groupName = 'kgenui-gq-' + cssToken(questionId);
      // <fieldset>/<legend> ties the radiogroup's accessible name back to the
      // question — without it, a screen reader announces each option with no
      // indication of which question they answer. The legend duplicates the
      // prompt already shown visibly above, so it's screen-reader-only.
      const fieldset = el('fieldset', 'kgenui__options-group');
      const legend = el('legend', 'kgenui__sr-only', prompt || 'Answer choices');
      fieldset.appendChild(legend);
      const list = el('ul', 'kgenui__list kgenui__options');
      list.setAttribute('role', 'list');
      for (const o of options) {
        const li = el('li');
        const id = groupName + '-' + cssToken(o.id);
        const input = el('input', 'kgenui__radio');
        input.type = 'radio'; input.name = groupName; input.id = id; input.value = o.id;
        input.addEventListener('change', () => { selectedId = o.id; });
        inputs.push(input);
        const lbl = el('label', 'kgenui__option-label', o.text);
        lbl.htmlFor = id;
        li.append(input, lbl);
        list.appendChild(li);
      }
      fieldset.appendChild(list);
      root.appendChild(fieldset);
      const submit = el('button', 'kgenui__submit', 'Submit answer');
      submit.type = 'button';
      submit.addEventListener('click', () => {
        if (!selectedId) return;   // require a selection before grading
        const opt = options.find((o) => o.id === selectedId);
        const correct = correctOptionId == null ? null : selectedId === correctOptionId;
        reveal(correct, (opt && opt.text) || '', selectedId);
        submit.disabled = true;
        for (const inp of inputs) inp.disabled = true;
      });
      root.appendChild(submit);
    } else {
      let textValue = '';
      const input = el('input', 'kgenui__input');
      input.type = 'text';
      input.setAttribute('aria-label', prompt || 'Your answer');
      input.addEventListener('input', () => { textValue = input.value; });
      root.appendChild(input);
      // Pre-built hidden, like flashcards' answer span — revealed via .textContent + .hidden,
      // never insertBefore (mirrors this module's existing toggle pattern; never a DOM-query API).
      const echo = el('p', 'kgenui__answer-echo');
      echo.hidden = true;
      const submit = el('button', 'kgenui__submit', 'Submit answer');
      submit.type = 'button';
      const submitAnswer = () => {
        // Sanitize BEFORE grading AND before any DOM insertion —
        // never grade or echo the raw input value.
        const sanitized = safeText(textValue, 2000);
        const correct = acceptedAnswers.length === 0 ? null
          : acceptedAnswers.some((a) => a.toLowerCase() === sanitized.trim().toLowerCase());
        submit.disabled = true;
        input.disabled = true;
        echo.textContent = 'Your answer: ' + sanitized;   // sanitized value only — never the raw one
        echo.hidden = false;
        reveal(correct, sanitized, null);
      };
      submit.addEventListener('click', submitAnswer);
      // Enter submits, matching a real <form>'s implicit-submit behavior — this
      // isn't wrapped in a <form> (mountWidget never nests forms inside a host
      // page's own), so without this a keyboard user must Tab to the button.
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitAnswer(); });
      root.appendChild(submit);
      root.appendChild(echo);
    }
    root.append(feedback, explanationEl);
  },
};

/** Hard cap on rendered graded-question options — bounds DOM size against a malformed/adversarial descriptor. */
const MAX_GQ_OPTIONS = 8;

function buildUnknown(root, data) {
  root.classList.add('kgenui--unknown');
  root.appendChild(el('p', 'kgenui__muted', 'Unsupported widget — shown as a safe fallback.'));
  if (data && data.runtime) root.appendChild(el('span', 'kgenui__meta', safeText(data.runtime, 100)));
}
function buildError(root, data) {
  root.classList.add('kgenui--error');
  root.appendChild(el('p', 'kgenui__muted', 'This widget could not be rendered.'));
  if (data && data.message) root.appendChild(el('span', 'kgenui__meta', safeText(data.message, 300)));
}

/* ─────────────── tiny DOM helpers (no innerHTML, ever) ─────────────── */

function titleEl(root, t) { const s = safeText(t, 300); if (s) root.appendChild(el('h3', 'kgenui__title', s)); }
function listEl(root, items, makeLi) {
  if (!items.length) return;
  const ul = el('ul', 'kgenui__list');
  ul.setAttribute('role', 'list');
  for (const it of items) ul.appendChild(makeLi(it));
  root.appendChild(ul);
}
function gallery(root, items, makeCard) {
  const ul = el('ul', 'kgenui__list kgenui__gallery');
  ul.setAttribute('role', 'list');
  for (const it of items) ul.appendChild(makeCard(it));
  root.appendChild(ul);
}
/** A scheme-checked external link with a screen-reader "new tab" cue + an optional onAction('open'). */
function link(url, label, onAction) {
  const a = renderSafeLink({ url, label }, {});   // null when unsafe / no DOM
  if (!a) return null;
  a.className = 'kgenui__link';
  const cue = el('span', 'kgenui__sr-only', ' (opens in a new tab)');
  a.appendChild(cue);
  if (typeof onAction === 'function') a.addEventListener('click', () => onAction('open', { url: a.href }));
  return a;
}
/**
 * A sandboxed embed <iframe> — but ONLY for an explicit allow-list of embed
 * hosts (YouTube/Vimeo/Kaltura). Any other origin returns null so the caller
 * falls back to a link rather than iframing an arbitrary URL. Defense-in-depth:
 * the descriptor's `embedUrl` is already normalized by core/kaltura-media.js;
 * this re-checks the host at the DOM boundary.
 */
function safeIframe(url, title) {
  const src = safeUrl(url, { allow: ['https'] });
  if (!src) return null;
  let host;
  try { host = new URL(src).host.toLowerCase(); } catch { return null; }
  if (!EMBED_HOSTS.includes(host)) return null;
  const wrap = el('div', 'kgenui__embed');
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
  frame.setAttribute('src', src);
  frame.src = src;
  frame.title = safeText(title || 'Embedded video', 300);
  frame.loading = 'lazy';
  frame.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen');
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  wrap.appendChild(frame);
  return wrap;
}

/** A scheme-checked <img> — drops entirely when the URL is unsafe. */
function safeImg(url, alt) {
  const src = safeUrl(url, {});
  if (!src) return null;
  const img = el('img', 'kgenui__img');
  img.src = src;
  img.alt = safeText(alt || '', 300);
  img.loading = 'lazy';
  return img;
}
function asArray(v) { return Array.isArray(v) ? v : []; }
function titleCase(s) { return String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()); }
/** Map a backend field `type` to an <input type>. */
function htmlInputType(t) {
  switch (String(t || '').toLowerCase()) {
    case 'email': return 'email';
    case 'phone': return 'tel';
    case 'int': case 'float': return 'number';
    case 'bool': return 'checkbox';
    default: return 'text';
  }
}
/** A mobile inputmode hint for numeric/contact fields. */
function inputMode(t) {
  switch (String(t || '').toLowerCase()) {
    case 'email': return 'email';
    case 'phone': return 'tel';
    case 'int': return 'numeric';
    case 'float': return 'decimal';
    default: return '';
  }
}

/**
 * Transcript rendering for Nova's conversation UI: speaker-labeled messages
 * with streaming same-speaker glue, plus the "Nova is thinking" dots shown
 * while a chat reply is on the way. Pure DOM, no SDK dependency — connect.js
 * owns the session and decides when to call these.
 *
 * Nova's replies render a small markdown subset (bold, inline code, links,
 * bullet and numbered lists) built from DOM nodes only, never innerHTML, so
 * model output can't inject markup. The visitor's own lines stay literal.
 */
import { withPrefix } from './router.js';

let transcriptEl = null;
let thinkingEl = null;
let thinkingTimer = null;
let jumpEl = null;

/** Within this many px of the bottom counts as "reading the latest". */
const PIN_SLACK = 48;

export function initTranscript(el) {
  transcriptEl = el;
  transcriptEl.addEventListener('scroll', () => { if (isPinned()) hideJump(); }, { passive: true });
}

/** Empty the transcript (new conversation). */
export function clearTranscript() {
  transcriptEl.innerHTML = '';
  hideJump();
}

function isPinned() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <= PIN_SLACK;
}

function hideJump() {
  if (jumpEl) jumpEl.hidden = true;
}

/** Follow new content only if the visitor was already at the bottom; otherwise
 * leave their scroll alone and offer a way back. */
function followOrOffer(wasPinned) {
  if (wasPinned) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    hideJump();
    return;
  }
  if (!jumpEl) {
    jumpEl = document.createElement('button');
    jumpEl.type = 'button';
    jumpEl.className = 'nova-jump';
    jumpEl.textContent = 'Jump to latest';
    jumpEl.addEventListener('click', () => {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      hideJump();
    });
    transcriptEl.after(jumpEl);
  }
  jumpEl.hidden = false;
}

const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]*[^\s<>).,;:!?])/g;
const LIST_RE = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;

/** http(s) and root-relative only: anything else (javascript:, data:, //host, /\host) stays text. */
function safeHref(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/(?![\/\\])/.test(url)) return withPrefix(url);
  return null;
}

function appendLink(parent, text, url) {
  const href = safeHref(url);
  if (!href) { parent.append(text); return; }
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (/^https?:\/\//i.test(href)) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  parent.append(a);
}

function renderInline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const b = document.createElement('strong');
      b.textContent = m[1];
      parent.append(b);
    } else if (m[2] !== undefined) {
      const c = document.createElement('code');
      c.textContent = m[2];
      parent.append(c);
    } else if (m[3] !== undefined) {
      appendLink(parent, m[3], m[4]);
    } else {
      appendLink(parent, m[5], m[5]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(el, raw) {
  el.textContent = '';
  const lines = raw.split('\n');
  let prevWasText = false;
  for (const line of lines) {
    const li = LIST_RE.exec(line);
    if (li) {
      const item = document.createElement('span');
      item.className = 'nova-list-item';
      item.dataset.marker = li[1] ? '•' : `${li[2]}.`;
      renderInline(item, li[3]);
      el.append(item);
      prevWasText = false;
      continue;
    }
    if (prevWasText) el.append(document.createElement('br'));
    renderInline(el, line);
    prevWasText = true;
  }
}

// Defensive filter for a bare ASR/TTS control token ("<tag>") arriving as a
// transcript segment: it carries no content for a visitor to read. A silent
// opening never reaches here; connect.js drops its SILENT_OPENING_LABEL
// caption. A spoken opening (Nova's intro) arrives as normal text. Matches only
// a segment that IS one such tag start to finish, so a reply that merely
// mentions "<foo>" as real text is never touched.
const FILLER_TOKEN_RE = /^<[^<>]+>$/;

export function appendTranscript(who, text) {
  if (FILLER_TOKEN_RE.test(text.trim())) return;
  const cls = who === 'you' ? 'nova-you' : 'nova-nova';
  // The thinking dots stay pinned to the bottom: messages land above them,
  // and the glue check looks at the last real message, not the dots.
  const last = thinkingEl ? thinkingEl.previousElementSibling : transcriptEl.lastElementChild;
  const wasPinned = isPinned();
  // Nova's replies stream in segments — glue consecutive same-speaker
  // segments into one paragraph instead of a "Nova:"-prefixed line each.
  if (last && last.className === cls) {
    const body = last.querySelector('.nova-msg');
    const raw = body.dataset.raw;
    body.dataset.raw = `${raw}${/\s$/.test(raw) || /^\s/.test(text) ? '' : ' '}${text}`;
    paint(body, cls);
  } else {
    const p = document.createElement('p');
    p.className = cls;
    const label = document.createElement('strong');
    label.className = 'nova-label';
    label.textContent = who === 'you' ? 'You:' : 'Nova:';
    const body = document.createElement('span');
    body.className = 'nova-msg';
    body.dataset.raw = text;
    paint(body, cls);
    p.append(label, ' ', body);
    transcriptEl.insertBefore(p, thinkingEl);
  }
  // The visitor's own line always scrolls into view; Nova's replies only when
  // they were already reading the bottom.
  followOrOffer(wasPinned || who === 'you');
}

/**
 * A link button on its own transcript line, for a client tool that offers the
 * visitor a page action. The caller passes a fixed label and URL, never text
 * from the model. Opens in a new tab. Does nothing if a link with the same
 * `key` is already in the transcript, so a repeated tool call adds no second
 * button.
 */
export function appendActionLink(key, label, url) {
  if (transcriptEl.querySelector(`[data-action="${key}"]`)) return;
  const wasPinned = isPinned();
  const p = document.createElement('p');
  p.className = 'nova-action';
  const a = document.createElement('a');
  a.className = 'nova-cta';
  a.dataset.action = key;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  p.append(a);
  transcriptEl.insertBefore(p, thinkingEl);
  followOrOffer(wasPinned);
}

function paint(body, cls) {
  if (cls === 'nova-nova') renderMarkdown(body, body.dataset.raw);
  else body.textContent = body.dataset.raw;
}

/**
 * "Nova is thinking" dots — chat mode has no talking avatar to signal that a
 * reply is on the way, so the seconds between sending and the first streamed
 * segment otherwise look like nothing is happening. The 45s timer is a
 * backstop for a reply that never arrives; every normal removal path
 * (first reply segment, error, switch to video, session end) is wired in
 * connect.js.
 */
export function showThinking() {
  if (!transcriptEl || thinkingEl) return;
  const wasPinned = isPinned();
  thinkingEl = document.createElement('p');
  thinkingEl.className = 'nova-thinking';
  thinkingEl.setAttribute('role', 'status');
  thinkingEl.setAttribute('aria-label', 'Nova is thinking');
  for (let i = 0; i < 4; i++) thinkingEl.appendChild(document.createElement('span'));
  transcriptEl.appendChild(thinkingEl);
  transcriptEl.setAttribute('aria-busy', 'true');
  followOrOffer(wasPinned);
  thinkingTimer = setTimeout(hideThinking, 45000);
}

export function hideThinking() {
  clearTimeout(thinkingTimer);
  thinkingTimer = null;
  thinkingEl?.remove();
  thinkingEl = null;
  transcriptEl?.removeAttribute('aria-busy');
}

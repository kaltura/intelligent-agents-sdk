/**
 * Transcript rendering for Nova's conversation UI: speaker-labeled messages
 * with streaming same-speaker glue, plus the "Nova is thinking" dots shown
 * while a chat reply is on the way. Pure DOM, no SDK dependency — connect.js
 * owns the session and decides when to call these.
 */

let transcriptEl = null;
let thinkingEl = null;
let thinkingTimer = null;

export function initTranscript(el) {
  transcriptEl = el;
}

// ASR/TTS control tokens (e.g. "<blank>", the SSML silence tag used as
// Nova's avatar openingPhrase — see docs-site-avatar/server/provision.mjs)
// arrive as real transcript segments but carry no content for a visitor to
// read. Matches only a segment that IS one such tag start to finish, so a
// reply that merely mentions "<foo>" as real text is never touched.
const FILLER_TOKEN_RE = /^<[^<>]+>$/;

// Chats resume on this browser (see connect.js's STORE_THREAD) but a fresh
// page load has no DOM — without this, "continuing" a conversation looked
// like starting a blank one even though Nova herself remembered everything.
// Persisted as whole rendered paragraphs (post-glue, post-filler-filter), so
// restoring just replays them through the same appendTranscript() a live
// reply would use. Capped well past what the drawer's height can show at
// once, so restoring never needs its own separate trim pass.
const STORE_HISTORY = 'nova:history';
const HISTORY_LIMIT = 40;

function persistHistory() {
  if (!transcriptEl) return;
  const entries = [];
  for (const el of transcriptEl.children) {
    if (el === thinkingEl) continue;
    entries.push({ who: el.classList.contains('nova-you') ? 'you' : 'nova', text: el.querySelector('.nova-msg')?.textContent ?? '' });
  }
  try { localStorage.setItem(STORE_HISTORY, JSON.stringify(entries.slice(-HISTORY_LIMIT))); } catch { /* storage disabled — history just won't persist */ }
}

export function appendTranscript(who, text) {
  if (FILLER_TOKEN_RE.test(text.trim())) return;
  const cls = who === 'you' ? 'nova-you' : 'nova-nova';
  // The thinking dots stay pinned to the bottom: messages land above them,
  // and the glue check looks at the last real message, not the dots.
  const last = thinkingEl ? thinkingEl.previousElementSibling : transcriptEl.lastElementChild;
  // Nova's replies stream in segments — glue consecutive same-speaker
  // segments into one paragraph instead of a "Nova:"-prefixed line each.
  if (last && last.className === cls) {
    const body = last.querySelector('.nova-msg');
    body.textContent += `${/\s$/.test(body.textContent) || /^\s/.test(text) ? '' : ' '}${text}`;
  } else {
    const p = document.createElement('p');
    p.className = cls;
    const label = document.createElement('strong');
    label.className = 'nova-label';
    label.textContent = who === 'you' ? 'You:' : 'Nova:';
    const body = document.createElement('span');
    body.className = 'nova-msg';
    body.textContent = text;
    p.append(label, ' ', body);
    transcriptEl.insertBefore(p, thinkingEl);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  persistHistory();
}

/** Replays a prior visit's rendered transcript from localStorage — call once
 * at startup, before any live session exists. No-op with nothing saved, and
 * no-op if the transcript already has content: connect.js's own call is
 * gated behind a network fetch (the jsDelivr SDK import), so on a slow
 * connection it can land after real messages already arrived — restoring
 * over those would duplicate them instead of restoring a blank transcript. */
export function restoreHistory() {
  if (!transcriptEl || transcriptEl.children.length) return;
  let entries;
  try { entries = JSON.parse(localStorage.getItem(STORE_HISTORY) || '[]'); } catch { entries = null; }
  if (!Array.isArray(entries)) return;
  for (const { who, text } of entries) {
    if ((who === 'you' || who === 'nova') && text) appendTranscript(who, text);
  }
}

/** Forget the saved transcript — paired with forgetting STORE_THREAD
 * (connect.js's "New conversation" and its stale-thread retry path). */
export function clearHistory() {
  try { localStorage.removeItem(STORE_HISTORY); } catch { /* ditto */ }
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
  thinkingEl = document.createElement('p');
  thinkingEl.className = 'nova-thinking';
  thinkingEl.setAttribute('role', 'status');
  thinkingEl.setAttribute('aria-label', 'Nova is thinking');
  for (let i = 0; i < 4; i++) thinkingEl.appendChild(document.createElement('span'));
  transcriptEl.appendChild(thinkingEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  thinkingTimer = setTimeout(hideThinking, 45000);
}

export function hideThinking() {
  clearTimeout(thinkingTimer);
  thinkingTimer = null;
  thinkingEl?.remove();
  thinkingEl = null;
}

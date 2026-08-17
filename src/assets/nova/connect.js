/**
 * Nova — the live SDK-docs avatar embedded in this site's hero section
 * (see index.md). Mints its own anonymous widget KS in-browser, exactly how
 * the Kaltura Player itself gets a token client-side — no server, no admin
 * secret ever reaches this page. Imports the SDK straight from a jsDelivr
 * GitHub-CDN URL pinned to a release tag (no npm install, no bundler); bump
 * SDK_TAG when a new SDK version ships.
 *
 * PARTNER_ID/WIDGET_ID identify the live "Nova — SDK Docs Assistant" agent
 * provisioned by apps/docs-site-avatar/server/provision.mjs in the SDK's
 * private monorepo — safe to ship client-side (see sessions.createWidgetToken).
 */
import './router.js';
import { withPrefix } from './router.js';
import { initDock, enterDockMode } from './dock.js';
import { initNavigator } from './navigator.js';
import { initHighlighter } from './highlighter.js';

// SDK version pin -- keep in sync with: intelligent-agents-sdk-site/src/index.md
// (quick-start jsDelivr pin) and docs-site-avatar/scripts/fetch-sdk.mjs (DEFAULT_TAG).
const SDK_TAG = 'v1.1.0';
const SDK_BASE = `https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@${SDK_TAG}`;

const { KalturaAvatarSession } = await import(`${SDK_BASE}/src/experience/index.js`);
const { Management } = await import(`${SDK_BASE}/src/management/index.js`);

const PARTNER_ID = '6516742';
const WIDGET_ID = '1_g7ntgoq2';

// The synthetic first message Nova's system prompt (obeyRules) is keyed on —
// the brain otherwise stays silent until a visitor speaks first.
const KICKOFF_TRIGGER = 'hi, start session!';

const els = {
  widget: document.getElementById('nova-widget'),
  video: document.getElementById('nova-video'),
  placeholder: document.getElementById('nova-placeholder'),
  disclosure: document.getElementById('nova-disclosure'),
  disclosureChip: document.getElementById('nova-disclosure-chip'),
  status: document.getElementById('nova-status'),
  transcript: document.getElementById('nova-transcript'),
  mute: document.getElementById('nova-mute'),
  muteIcon: document.getElementById('nova-mute-icon'),
  end: document.getElementById('nova-end'),
  videoWrap: document.getElementById('nova-video-wrap'),
  promptsRow: document.querySelector('.nova-hero-prompts'),
  chips: Array.from(document.querySelectorAll('.nova-chip')),
};

// Nova's real catalog-visual likeness, shown via <video poster> so her face
// is always on screen — before connect, while connecting, and as the first
// frame — instead of the browser's native black box while WebRTC has no
// frames yet. eleventy's pathPrefix transform only rewrites href=/src=, not
// poster=, so this has to be set at runtime via the same withPrefix() the
// router already uses.
if (els.video) els.video.poster = withPrefix('/assets/nova/img/nova-portrait.webp');

initDock();

// Docking is one-directional per session: the first in-site navigation
// while connected shrinks Nova into the standing corner dock and she never
// returns to hero size (see dock.js). Navigating away unconnected already
// docks her too, via dock.js's own trackHero()->missing-slot check.
document.addEventListener('nova:pagechange', () => {
  if (session) enterDockMode();
});

els.widget.addEventListener('click', (e) => {
  if (!els.widget.classList.contains('dock-mode')) return;
  if (e.target.closest('.nova-btn')) return;
  els.widget.classList.toggle('expanded');
});

let session = null;
let connecting = false;

function setStatus(text) {
  els.status.textContent = text;
}

function appendTranscript(who, text) {
  const p = document.createElement('p');
  p.className = who === 'you' ? 'nova-you' : 'nova-nova';
  p.textContent = `${who === 'you' ? 'You' : 'Nova'}: ${text}`;
  els.transcript.appendChild(p);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function ensureSocketIo() {
  if (typeof window.io === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    s.integrity = 'sha384-2huaZvOR9iDzHqslqwpR87isEmrfxqyWOF7hr7BY6KG0+hVKLoEXMPUJw3ynWuhO';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('socket.io failed to load'));
    document.head.appendChild(s);
  });
}

async function connect(pendingPrompt) {
  if (connecting || session) return;
  connecting = true;
  els.videoWrap?.classList.add('is-connecting');
  setStatus('Connecting…');
  try {
    await ensureSocketIo();
    const kaltura = new Management({ partnerId: PARTNER_ID });
    const widget = await kaltura.sessions.createWidgetToken({ widgetId: WIDGET_ID });
    const init = await kaltura.application.appInit(widget.ks);

    session = new KalturaAvatarSession({
      token: init.ks,
      conversationManagerUrl: init.conversationManagerUrl,
      srsBaseUrl: init.srsBaseUrl,
      turnServerUrl: init.turnServerUrl,
      videoEl: els.video,
      socketFactory: (url, opts) => window.io(url, opts),
      isFirefox: /firefox/i.test(navigator.userAgent),
      // EU AI Act Article 50 — the always-visible badge below IS the
      // disclosure; it is shown before speak() can run and never dismissed.
      requireDisclosureAck: true,
    });

    session.on('transcript', (tr) => {
      if (tr.type === 'user' && tr.text && tr.text !== KICKOFF_TRIGGER) appendTranscript('you', tr.text);
    });
    session.on('avatarStartTalking', () => els.videoWrap?.classList.add('is-talking'));
    session.on('avatarStopTalking', (p) => {
      els.videoWrap?.classList.remove('is-talking');
      if (p?.text) appendTranscript('nova', p.text);
    });
    session.on('interrupted', () => els.videoWrap?.classList.remove('is-talking'));

    session.on('disclosure', () => {
      els.disclosure.classList.remove('hidden');
      els.disclosureChip.classList.remove('hidden');
      session.acknowledgeDisclosure();
    });
    session.on('error', (e) => setStatus(`Connection issue: ${e.detail || e.code}`));
    session.on('reconnecting', () => setStatus('Reconnecting…'));
    session.on('reconnected', () => setStatus('Reconnected'));
    session.on('ended', () => resetUi());

    initNavigator(session);
    initHighlighter(session);

    await session.connect();
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    els.placeholder.classList.add('hidden');
    els.promptsRow?.classList.add('hidden');
    els.mute.disabled = false;
    els.end.disabled = false;
    setStatus('Connected — ask Nova anything about the SDK.');

    // Kick off the conversation — wait for the avatar's silent opening turn to
    // clear (or time out) so this doesn't race the CM's own automatic turn.
    const openingCleared = new Promise((resolve) => session.once('avatarStopTalking', resolve));
    await Promise.race([openingCleared, new Promise((r) => setTimeout(r, 3000))]);
    await session.speak(KICKOFF_TRIGGER);
    if (pendingPrompt) await session.speak(pendingPrompt);
  } catch (e) {
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    setStatus(`Could not connect: ${e.detail || e.message || 'unknown error'}`);
  }
}

function toggleMute() {
  if (!session) return;
  if (session.micEnabled) {
    session.mute();
    els.muteIcon.textContent = 'mic_off';
    els.mute.setAttribute('aria-label', 'Unmute');
  } else {
    session.unmute();
    els.muteIcon.textContent = 'mic';
    els.mute.setAttribute('aria-label', 'Mute');
  }
}

function endSession() {
  session?.disconnect();
  resetUi();
}

function resetUi() {
  session = null;
  connecting = false;
  els.videoWrap?.classList.remove('is-connecting', 'is-talking');
  els.placeholder.classList.remove('hidden');
  els.promptsRow?.classList.remove('hidden');
  els.disclosure.classList.add('hidden');
  els.disclosureChip.classList.add('hidden');
  els.mute.disabled = true;
  els.muteIcon.textContent = 'mic';
  els.mute.setAttribute('aria-label', 'Mute');
  els.end.disabled = true;
  setStatus('Session ended.');
}

els.placeholder.addEventListener('click', () => {
  if (!session) connect();
});
els.placeholder.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !session) {
    e.preventDefault();
    connect();
  }
});
els.mute.addEventListener('click', toggleMute);
els.end.addEventListener('click', endSession);

// NN/g-validated "use-case prompt suggestion" pattern (the same one ChatGPT/
// Claude/Poe use pre-auth): each chip both starts the session AND asks its
// exact question, instead of dropping a visitor into a blank "now what?" call.
els.chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.dataset.prompt;
    if (session) session.speak(prompt);
    else connect(prompt);
  });
});

/**
 * Nova — the live SDK-docs avatar embedded in this site's hero section
 * (see index.md). Mints its own anonymous widget KS in-browser, exactly how
 * the Kaltura Player itself gets a token client-side — no server, no admin
 * secret ever reaches this page. Imports the SDK straight from a jsDelivr
 * GitHub-CDN URL pinned to a release tag (no npm install, no bundler); bump
 * SDK_TAG when a new SDK version ships.
 *
 * One conversation, two transports: KalturaAgentSession runs Nova over live
 * avatar video (WebRTC + socket) or text-only chat (HTTP streaming), and
 * switchMode() moves between them mid-conversation on the same thread.
 * Visitors can start either way — click the video to talk, or type/use the
 * "chat without video" affordance to skip WebRTC and mic permissions.
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
const SDK_TAG = 'v1.6.0';
const SDK_BASE = `https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@${SDK_TAG}`;

const { KalturaAgentSession } = await import(`${SDK_BASE}/src/experience/index.js`);
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
  chatStart: document.getElementById('nova-chat-start'),
  disclosure: document.getElementById('nova-disclosure'),
  disclosureChip: document.getElementById('nova-disclosure-chip'),
  status: document.getElementById('nova-status'),
  transcript: document.getElementById('nova-transcript'),
  mute: document.getElementById('nova-mute'),
  muteIcon: document.getElementById('nova-mute-icon'),
  mode: document.getElementById('nova-mode'),
  modeIcon: document.getElementById('nova-mode-icon'),
  end: document.getElementById('nova-end'),
  inputRow: document.getElementById('nova-input-row'),
  input: document.getElementById('nova-input'),
  send: document.getElementById('nova-send'),
  videoWrap: document.getElementById('nova-video-wrap'),
  promptsRow: document.querySelector('.nova-hero-prompts'),
  chips: Array.from(document.querySelectorAll('.nova-chip')),
};

// Nova's real catalog-visual likeness, shown via <video poster> so her face
// is always on screen — before connect, while connecting, and as the first
// frame — instead of the browser's native black box while WebRTC has no
// frames yet. eleventy's pathPrefix transform only rewrites href=/src=, not
// poster=, so this has to be set at runtime via the same withPrefix() the
// router already uses. In chat mode the poster IS the visual: the transport
// never attaches a stream, so her portrait simply stays up.
if (els.video) els.video.poster = withPrefix('/assets/nova/img/nova-portrait.webp');

// On a 2g-class link WebRTC video is a bad first experience; text chat skips
// it entirely. Feature-detected (Chromium-only API), a nudge, never forced.
const netType = navigator.connection?.effectiveType;
if (netType === 'slow-2g' || netType === '2g') els.chatStart?.classList.add('nova-slow-net');

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
  if (e.target.closest('.nova-btn') || e.target.closest('.nova-input-row')) return;
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

function showDisclosure() {
  els.disclosure.classList.remove('hidden');
  els.disclosureChip.classList.remove('hidden');
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

/**
 * Mode-specific wiring, redone on every `transportChanged` (initial attach
 * and each switchMode). Listeners on the old transport die with it — the
 * facade disconnects it — so only the fresh transport needs wiring.
 */
function wireTransport(transport, mode) {
  els.widget.classList.toggle('chat-mode', mode === 'chat');
  els.mute.disabled = mode !== 'avatar';
  els.modeIcon.textContent = mode === 'avatar' ? 'chat' : 'videocam';
  const label = mode === 'avatar' ? 'Switch to text chat' : 'Switch to live video';
  els.mode.setAttribute('aria-label', label);
  els.mode.title = label;

  if (mode === 'avatar') {
    transport.on('avatarStartTalking', () => els.videoWrap?.classList.add('is-talking'));
    transport.on('avatarStopTalking', () => els.videoWrap?.classList.remove('is-talking'));
    transport.on('interrupted', () => els.videoWrap?.classList.remove('is-talking'));
    // EU AI Act Article 50 — the always-visible badge IS the disclosure; it
    // is shown before speak() can run and never dismissed.
    transport.on('disclosure', () => {
      showDisclosure();
      transport.acknowledgeDisclosure();
    });
    transport.on('reconnecting', () => setStatus('Reconnecting…'));
    transport.on('reconnected', () => setStatus('Reconnected'));
  } else {
    els.videoWrap?.classList.remove('is-talking');
    // Text chat is still an AI conversation — same disclosure, shown
    // directly (chat has no ack handshake to gate on).
    showDisclosure();
    // Drop the dead WebRTC stream so the <video> falls back to the poster.
    if (els.video) {
      els.video.srcObject = null;
      els.video.load();
    }
  }
}

async function connect(pendingPrompt, mode = 'avatar') {
  if (connecting || session) return;
  connecting = true;
  els.videoWrap?.classList.add('is-connecting');
  setStatus(mode === 'chat' ? 'Starting chat…' : 'Connecting…');
  try {
    if (mode === 'avatar') await ensureSocketIo();
    const kaltura = new Management({ partnerId: PARTNER_ID });
    const widget = await kaltura.sessions.createWidgetToken({ widgetId: WIDGET_ID });
    const init = await kaltura.application.appInit(widget.ks);

    session = new KalturaAgentSession({
      token: init.ks,
      mode,
      // Avatar cfg is needed even for a chat-first session: switchMode()
      // builds the avatar transport from it later. Chat cfg is omitted —
      // the SDK's production genieUrl default is exactly where Nova lives.
      avatar: {
        conversationManagerUrl: init.conversationManagerUrl,
        srsBaseUrl: init.srsBaseUrl,
        turnServerUrl: init.turnServerUrl,
        videoEl: els.video,
        socketFactory: (url, opts) => window.io(url, opts),
        isFirefox: /firefox/i.test(navigator.userAgent),
        requireDisclosureAck: true,
      },
    });

    // Both transports emit the same transcript shape: 'user' echoes the
    // visitor's turn, 'final' carries each of Nova's reply segments.
    session.on('transcript', (tr) => {
      if (tr.type === 'user' && tr.text && tr.text !== KICKOFF_TRIGGER) appendTranscript('you', tr.text);
      else if (tr.type === 'final' && tr.text) appendTranscript('nova', tr.text);
    });
    session.on('error', (e) => setStatus(`Connection issue: ${e.detail || e.code}`));
    session.on('ended', () => resetUi());
    session.on('transportChanged', ({ mode: m, transport }) => wireTransport(transport, m));
    session.on('modeChanged', ({ mode: m }) =>
      setStatus(m === 'chat' ? 'Text chat — same conversation, no video.' : 'Live video — same conversation.'));

    initNavigator(session);
    initHighlighter(session);

    await session.connect();
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    els.placeholder.classList.add('hidden');
    els.chatStart?.classList.add('hidden');
    els.promptsRow?.classList.add('hidden');
    els.mode.disabled = false;
    els.end.disabled = false;
    setStatus('Connected — ask Nova anything about the SDK.');

    if (mode === 'avatar') {
      // Kick off the conversation — wait for the avatar's silent opening
      // turn to clear (or time out) so this doesn't race the CM's own
      // automatic turn. Chat has no automatic opening turn to race.
      const openingCleared = new Promise((resolve) => session.transport.once('avatarStopTalking', resolve));
      await Promise.race([openingCleared, new Promise((r) => setTimeout(r, 3000))]);
    }
    await session.sendText(KICKOFF_TRIGGER);
    if (pendingPrompt) await session.sendText(pendingPrompt);
  } catch (e) {
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    setStatus(`Could not connect: ${e.detail || e.message || 'unknown error'}`);
  }
}

async function sendUserText(text) {
  if (!session || session.state !== 'connected') return;
  try {
    await session.sendText(text);
  } catch (e) {
    setStatus(`Could not send: ${e.detail || e.message || 'unknown error'}`);
  }
}

async function toggleMode() {
  if (!session || session.state !== 'connected') return;
  const target = session.mode === 'avatar' ? 'chat' : 'avatar';
  els.mode.disabled = true;
  els.videoWrap?.classList.add('is-connecting');
  setStatus(target === 'avatar' ? 'Switching to live video…' : 'Switching to text chat…');
  try {
    // Loading socket.io from the toggle click also keeps the browser's mic
    // permission prompt tied to a user gesture.
    if (target === 'avatar') await ensureSocketIo();
    await session.switchMode(target);
    els.mode.disabled = false;
  } catch (e) {
    // A failed switch is terminal: the facade lands in `failed` and the old
    // transport is already gone. disconnect() → 'ended' → resetUi().
    session?.disconnect();
    setStatus(`Could not switch: ${e.detail || e.message || 'unknown error'}`);
  } finally {
    els.videoWrap?.classList.remove('is-connecting');
  }
}

function toggleMute() {
  const t = session?.transport;
  if (!t || session.mode !== 'avatar') return;
  if (t.micEnabled) {
    t.mute();
    els.muteIcon.textContent = 'mic_off';
    els.mute.setAttribute('aria-label', 'Unmute');
  } else {
    t.unmute();
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
  els.widget.classList.remove('chat-mode');
  els.videoWrap?.classList.remove('is-connecting', 'is-talking');
  els.placeholder.classList.remove('hidden');
  els.chatStart?.classList.remove('hidden');
  els.promptsRow?.classList.remove('hidden');
  els.disclosure.classList.add('hidden');
  els.disclosureChip.classList.add('hidden');
  els.mute.disabled = true;
  els.muteIcon.textContent = 'mic';
  els.mute.setAttribute('aria-label', 'Mute');
  els.mode.disabled = true;
  els.modeIcon.textContent = 'chat';
  els.end.disabled = true;
  if (els.video) {
    els.video.srcObject = null;
    els.video.load();
  }
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
els.chatStart?.addEventListener('click', () => {
  if (!session) connect(undefined, 'chat');
});
els.mute.addEventListener('click', toggleMute);
els.mode.addEventListener('click', toggleMode);
els.end.addEventListener('click', endSession);

// Typing works in every state: mid-session it sends on the current transport
// (the avatar speaks her answer, chat streams it as text); with no session
// yet it starts one in chat mode — the visitor chose typing, so don't
// surprise them with a mic permission prompt.
els.inputRow.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  if (session) sendUserText(text);
  else connect(text, 'chat');
});

// NN/g-validated "use-case prompt suggestion" pattern (the same one ChatGPT/
// Claude/Poe use pre-auth): each chip both starts the session AND asks its
// exact question, instead of dropping a visitor into a blank "now what?" call.
els.chips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.dataset.prompt;
    if (session) sendUserText(prompt);
    else connect(prompt);
  });
});

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
 * provisioned by server/provision.mjs in the kaltura/docs-site-avatar repo —
 * safe to ship client-side (see sessions.createWidgetToken).
 */
import './router.js';
import { withPrefix } from './router.js';
import { initDock, enterDockMode, enterDrawerMode, exitDrawerMode } from './dock.js';
import { initTranscript, appendTranscript, showThinking, hideThinking } from './transcript.js';
import { initHighlighter } from './highlighter.js';
import { initSiteNav } from './site-nav.js';
import { SDK_BASE } from './sdk.js';

// Every way to start Nova stays hidden until this module has the SDK and has
// wired its handlers (it sets html.nova-ready at the end, see styles.css), so
// a click can never land on a pill or form that does nothing yet.
let KalturaAgentSession, SILENT_OPENING_LABEL, Management;
try {
  [{ KalturaAgentSession, SILENT_OPENING_LABEL }, { Management }] = await Promise.all([
    import(`${SDK_BASE}/src/experience/index.js`),
    import(`${SDK_BASE}/src/management/index.js`),
  ]);
} catch (e) {
  const status = document.getElementById('nova-status');
  if (status) status.textContent = 'Nova could not load. Reload the page to try again.';
  throw e;
}

const PARTNER_ID = '6516742';
const WIDGET_ID = '1_g7ntgoq2';

// The chat-first greeting only: text chat has no opening turn, so a chat
// session with no visitor question yet sends this as its first turn
// (`kickoff`). Video greets through the intellect's opening phrase instead
// (see NOVA_GREET). Nova's system prompt (provision.mjs obeyRules) is keyed
// on this exact string: greet on a fresh thread, greet back on a continued
// one, no tool calls. The eval harness (tests/eval/personas.mjs
// KICKOFF_TRIGGER) sends the same string. Keep all three in sync.
const KICKOFF_TRIGGER = 'Session started. Greet the visitor.';

// Client variable read by Nova's intellect opening phrase (provision.mjs).
// 'yes' on a brand-new thread speaks her scripted intro; '' renders the
// silent opening. A sent value sticks to the thread for later joins, so it
// is cleared with '' after the greeting, never by omitting the key.
const NOVA_GREET = 'nova_greet';

/**
 * `nova:uid` — a random UUID with no PII, minted only when the visitor
 * actually starts a conversation (never on a passive page view). It's this
 * browser's stable, first-party-only identity for the conversation backend's
 * audit trail (the SDK's opaque `subjectId`). Purely functional, never used
 * for tracking. Every page load starts a brand-new conversation thread —
 * Nova never resumes a prior visit's chat.
 */
const STORE_UID = 'nova:uid';

function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage disabled — session still works */ }
}

function visitorId() {
  let id = storeGet(STORE_UID);
  if (!id) {
    id = crypto.randomUUID();
    storeSet(STORE_UID, id);
  }
  return id;
}

const els = {
  widget: document.getElementById('nova-widget'),
  video: document.getElementById('nova-video'),
  audio: document.getElementById('nova-audio'),
  placeholder: document.getElementById('nova-placeholder'),
  chatStart: document.getElementById('nova-chat-start'),
  dockChat: document.getElementById('nova-dock-chat'),
  disclosure: document.getElementById('nova-disclosure'),
  disclosureChip: document.getElementById('nova-disclosure-chip'),
  status: document.getElementById('nova-status'),
  statusAction: document.getElementById('nova-status-action'),
  transcript: document.getElementById('nova-transcript'),
  mute: document.getElementById('nova-mute'),
  muteIcon: document.getElementById('nova-mute-icon'),
  mode: document.getElementById('nova-mode'),
  modeIcon: document.getElementById('nova-mode-icon'),
  newConvo: document.getElementById('nova-new'),
  end: document.getElementById('nova-end'),
  close: document.getElementById('nova-close'),
  inputRow: document.getElementById('nova-input-row'),
  input: document.getElementById('nova-input'),
  send: document.getElementById('nova-send'),
  videoWrap: document.getElementById('nova-video-wrap'),
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
let siteNav = null;
let highlighter = null;
let connecting = false;

// Typed lines shown locally in video mode, waiting for the server's copy.
// That copy arrives after Nova's reply has started, so showing it would put
// "you" below her answer. Chat sends its copy before the reply, so chat
// uses the SDK's copy and never adds here.
let localEchoes = [];

/** `text` minus every waiting local line it contains; '' if nothing is left. */
function dropLocalEchoes(text) {
  let rest = text;
  localEchoes = localEchoes.filter((line) => {
    if (!rest.includes(line)) return true;
    rest = rest.split(line).map((s) => s.trim()).filter(Boolean).join('\n');
    return false;
  });
  return rest;
}

function setStatus(text) {
  els.status.textContent = text;
  hideStatusAction();
}

/**
 * One-click recovery next to the status line, for the two warnings the SDK
 * leaves to the app because they need a user gesture: a blocked or missing
 * microphone (`startMic()` retries the capture) and autoplay-blocked audio
 * (`startPlayback()` retries play() on the bound media elements). Both live
 * on the avatar transport, not the facade. Any later setStatus() clears it.
 */
function offerStatusAction(label, action) {
  const btn = els.statusAction;
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await action();
    } catch (e) {
      setStatus(`Still unavailable: ${e.detail || e.message || e.code || 'unknown error'}. Type your question instead.`);
    }
  };
  btn.classList.remove('hidden');
}

function hideStatusAction() {
  if (!els.statusAction) return;
  els.statusAction.classList.add('hidden');
  els.statusAction.onclick = null;
}

function offerMicRetry() {
  offerStatusAction('Enable microphone', () => session?.transport?.startMic());
}

initTranscript(els.transcript);

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
  // Chat renders as the full-height side drawer; video renders in the hero
  // card / corner dock. Which buttons show in each mode is pure CSS keyed on
  // .chat-mode — video: mute + hang-up (drops to chat); chat: video toggle,
  // new conversation, close.
  if (mode === 'chat') enterDrawerMode();
  else exitDrawerMode();

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
    // Fires after a successful startMic() retry as well as at first connect;
    // the facade does not forward it, so it is wired here.
    transport.on('micStarted', () => setStatus('Microphone on.'));
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
  // Chat opens as the drawer immediately — the visitor sees where the
  // conversation will live while it connects, not a spinner in the corner.
  if (mode === 'chat') enterDrawerMode();
  setStatus(mode === 'chat' ? 'Starting chat…' : 'Connecting…');
  if (pendingPrompt) appendTranscript('you', pendingPrompt);
  try {
    if (mode === 'avatar') await ensureSocketIo();
    const kaltura = new Management({ partnerId: PARTNER_ID });
    const widget = await kaltura.sessions.createWidgetToken({ widgetId: WIDGET_ID });
    const init = await kaltura.application.appInit(widget.ks);

    // Three ways in:
    // - video, no question yet: the opening phrase speaks Nova's intro. It
    //   makes sound sooner than a kickoff reply. No kickoff.
    // - a chip click or a typed line, either mode: that is the visitor's real
    //   first question. Silent opening, and the question is the kickoff. It
    //   is already in the transcript (shown above, on click), so the server's
    //   copy is not echoed: in video it would land below Nova's answer.
    // - chat, no question yet: chat has no opening turn, so the hidden
    //   greeting trigger is the kickoff.
    const greet = mode === 'avatar' && !pendingPrompt;
    let kickoff;
    if (pendingPrompt) kickoff = { text: pendingPrompt, echo: false };
    else if (!greet) kickoff = KICKOFF_TRIGGER;

    session = new KalturaAgentSession({
      token: init.ks,
      mode,
      subjectId: visitorId(),
      requestVars: { [NOVA_GREET]: greet ? 'yes' : '' },
      // Sent by the SDK once, on the first transport: after the opening turn
      // ends (video) or once the transport is up (chat).
      ...(kickoff ? { kickoff } : {}),
      // Avatar cfg is needed even for a chat-first session: switchMode()
      // builds the avatar transport from it later. Chat cfg is omitted —
      // the SDK's production genieUrl default is exactly where Nova lives.
      avatar: {
        conversationManagerUrl: init.conversationManagerUrl,
        srsBaseUrl: init.srsBaseUrl,
        turnServerUrl: init.turnServerUrl,
        videoEl: els.video,
        audioEl: els.audio,
        socketFactory: (url, opts) => window.io(url, opts),
        isFirefox: /firefox/i.test(navigator.userAgent),
        requireDisclosureAck: true,
      },
    });

    // Both transports emit the same transcript shape: 'user' is the server's
    // copy of the visitor's turn, 'final' carries each of Nova's reply
    // segments. Her spoken intro is a normal 'final' line and shows as hers.
    // A 'user' line the site already showed (see localEchoes) is dropped;
    // what is left, such as a spoken turn, shows as the visitor's.
    session.on('transcript', (tr) => {
      if (tr.type === 'user' && tr.text) {
        const unseen = dropLocalEchoes(tr.text);
        if (unseen) appendTranscript('you', unseen);
      }
      // The avatar's silent opening turn reaches the app as the SDK's
      // SILENT_OPENING_LABEL caption; it is not something to show a visitor.
      else if (tr.type === 'final' && tr.text && tr.text !== SILENT_OPENING_LABEL) {
        hideThinking();
        appendTranscript('nova', tr.text);
      }
    });
    session.on('error', (e) => {
      hideThinking();
      setStatus(`Connection issue: ${e.detail || e.code}`);
    });
    // connect() no longer fails on a mic problem: the session comes up
    // mic-less and the reason arrives as a warning. Typing still works.
    session.on('warning', (w) => {
      if (w.code === 'mic_permission_denied') { setStatus('Microphone blocked. Type your question instead, or allow the mic and retry.'); offerMicRetry(); }
      else if (w.code === 'mic_not_found') setStatus('No microphone found. Type your question instead.');
      else if (w.code === 'mic_in_use' || w.code === 'mic_attach_failed') { setStatus('Microphone unavailable. Type your question instead.'); offerMicRetry(); }
      // Autoplay policy blocked Nova's audio/video; play() must come from a click.
      else if (w.code === 'playback_blocked') { setStatus('Your browser paused Nova\'s audio.'); offerStatusAction('Tap to hear Nova', () => session?.transport?.startPlayback()); }
      else if (w.code === 'kickoff_failed') { hideThinking(); setStatus('Nova could not start. Type a question to begin.'); }
    });
    // Thinking dots for text chat: the server's first think delta means the
    // turn (kickoff included) was accepted. In video mode the avatar's own
    // presence covers the wait.
    session.on('responsePending', () => { if (session?.mode === 'chat') showThinking(); });
    session.on('responseSettled', () => hideThinking());
    // `reason` is 'disconnected' for our own disconnect(), 'conversation_ended' when
    // the server closed the thread, otherwise the error code the 'error' handler
    // already put on the status line.
    session.on('ended', ({ reason } = {}) => resetUi(reason));
    session.on('transportChanged', ({ mode: m, transport }) => wireTransport(transport, m));
    session.on('modeChanged', ({ mode: m }) => {
      localEchoes = [];
      if (m === 'avatar') hideThinking();
      setStatus(m === 'chat' ? 'Text chat — same conversation, no video.' : 'Live video — same conversation.');
    });

    siteNav = initSiteNav(session);
    highlighter = initHighlighter(session, siteNav);

    await session.connect();
    // The intro has been rendered for this join. Clear the flag so a later
    // join of the same thread (switch back to video, cold reconnect) opens
    // silently instead of greeting again mid-conversation.
    if (greet) {
      try {
        session.updateRequestVars({ [NOVA_GREET]: '' });
      } catch { /* session already gone: nothing left to re-greet */ }
    }
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    els.placeholder.classList.add('hidden');
    els.chatStart?.classList.add('hidden');
    if (els.dockChat) els.dockChat.disabled = true;
    // A root class, not the pills row itself: the router swaps page content,
    // so a row found at load is gone after navigating back home.
    document.documentElement.classList.add('nova-live');
    els.mode.disabled = false;
    els.end.disabled = false;
    els.newConvo.disabled = false;
    els.close.disabled = false;
    setStatus('Connected — ask Nova anything about the SDK.');
    if (kickoff && mode === 'chat') showThinking();
  } catch (e) {
    connecting = false;
    els.videoWrap?.classList.remove('is-connecting');
    // The question never went out: drop its bubble so a retry doesn't glue onto it.
    const mine = els.transcript.lastElementChild;
    if (pendingPrompt && mine?.className === 'nova-you' && mine.querySelector('.nova-msg')?.textContent === pendingPrompt) mine.remove();
    setStatus(`Could not connect: ${e.detail || e.message || 'unknown error'}`);
  }
}

async function sendUserText(text) {
  if (!session || session.state !== 'connected') return;
  if (session.mode === 'chat') showThinking();
  else {
    // Video: the server's copy lands after Nova starts replying, so show it now.
    appendTranscript('you', text);
    localEchoes.push(text);
  }
  try {
    await session.sendText(text);
  } catch (e) {
    localEchoes = localEchoes.filter((line) => line !== text);
    hideThinking();
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

/** The × on the chat drawer: close the conversation UI entirely. */
function endSession() {
  session?.disconnect();
  resetUi();
}

/** End the current thread and start a fresh one right away, without closing
 * the drawer — same outcome a page reload gives, one click sooner. */
function newConversation() {
  session?.disconnect();
  resetUi();
  els.transcript.innerHTML = '';
  connect(undefined, 'chat');
}

function resetUi(reason) {
  session = null;
  siteNav?.destroy();
  siteNav = null;
  highlighter?.destroy();
  highlighter = null;
  connecting = false;
  localEchoes = [];
  hideThinking();
  els.widget.classList.remove('chat-mode');
  exitDrawerMode();
  els.videoWrap?.classList.remove('is-connecting', 'is-talking');
  els.placeholder.classList.remove('hidden');
  els.chatStart?.classList.remove('hidden');
  if (els.dockChat) els.dockChat.disabled = false;
  document.documentElement.classList.remove('nova-live');
  els.disclosure.classList.add('hidden');
  els.disclosureChip.classList.add('hidden');
  els.mute.disabled = true;
  els.muteIcon.textContent = 'mic';
  els.mute.setAttribute('aria-label', 'Mute');
  els.mode.disabled = true;
  els.newConvo.disabled = true;
  els.end.disabled = true;
  els.close.disabled = true;
  if (els.video) {
    els.video.srcObject = null;
    els.video.load();
  }
  if (!reason || reason === 'disconnected' || reason === 'ended') setStatus('Session ended.');
  else if (reason === 'conversation_ended') setStatus('Nova ended the session. Start a new one any time.');
  // Any other reason is an error code; the 'error' handler already explained it.
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
// Docked bubble's only other click target is the mic circle (avatar mode) —
// this is chat's way in without expanding the flyout first.
els.dockChat?.addEventListener('click', () => {
  if (!session) connect(undefined, 'chat');
});
els.mute.addEventListener('click', toggleMute);
// Chat mode's camera button and video mode's hang-up are the same action
// seen from either side: switchMode() on the same thread. Hanging up video
// doesn't end the conversation — it continues in the chat drawer; only the
// drawer's × (endSession) actually closes it.
els.mode.addEventListener('click', toggleMode);
els.end.addEventListener('click', toggleMode);
els.newConvo.addEventListener('click', newConversation);
els.close.addEventListener('click', endSession);

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
// Delegated, so chips in a home page the router swapped in work too.
document.addEventListener('click', (e) => {
  const prompt = e.target.closest?.('.nova-chip')?.dataset.prompt;
  if (!prompt) return;
  if (session) sendUserText(prompt);
  else connect(prompt);
});

document.documentElement.classList.add('nova-ready');

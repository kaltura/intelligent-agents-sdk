/**
 * Entry point: builds the stage, owns the one animation loop, and starts a
 * live session (default) or the scripted demo session (`?demo`).
 *
 *   ?demo    no credentials, scripted agent (works offline)
 *   ?kiosk   shared-screen mode: idle reset, attract wave, no cursor
 *   ?body=   a video-clip body folder under bodies/ (default: guide), or ?body=rig for the SVG robot.
 *            Screens under 600 px wide load <name>-lite first when that folder exists
 *   ?color=  accent color, for example ?color=ff6a3d
 *   ?theme=  light: a bright shop scene with dark text (default: dark)
 *   ?idle=   kiosk idle time in ms (default 90000); ?warn= sets the warning time (default 15000)
 */
import { h, s } from './dom.js';
import { createStore } from './store.js';
import { reducer, initialState } from './reducer.js';
import { pickLayout, unitFor } from './layout.js';
import { createRig } from './rig/rig.js';
import { loadClipBody } from './rig/clip-body.js';
import { createDirector } from './rig/director.js';
import { createPanel } from './panel.js';
import { createCaptions } from './captions.js';
import { createBridge, buildVars } from './bridge.js';
import { createKiosk } from './kiosk.js';
import { DemoSession } from './demo-session.js';
import { withRetry } from './retry.js';

const params = new URLSearchParams(location.search);
const demo = params.has('demo');
const kioskMode = params.has('kiosk');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const light = params.get('theme') === 'light';
const accent = /^[0-9a-f]{6}$/i.test(params.get('color') || '') ? `#${params.get('color')}` : null;

const LABELS = { connecting: 'Connecting', ready: 'Juno is here', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', muted: 'Mic off', blocked: 'Tap to hear Juno', error: 'Problem', ended: 'Conversation ended' };

const store = createStore(reducer, initialState());
const requested = params.get('body') ?? 'guide';
const bodyName = /^[\w-]+$/.test(requested) && requested !== 'rig' ? requested : null;
// A clip body that cannot load falls back to the SVG robot, so the demo never opens empty.
// Narrow screens load the smaller `<name>-lite` copy when it exists (and fall back to the full one).
const tryBody = (name) => loadClipBody(`bodies/${name}`, { reduced }).catch((e) => { console.warn(e.message); return null; });
const narrow = matchMedia('(max-width: 599px)').matches;
const body = (bodyName && ((narrow && await tryBody(`${bodyName}-lite`)) || await tryBody(bodyName))) || createRig({ reduced });
// The director adds the unprompted moves (hand gestures while she talks, nods while the customer does) and passes the rest through.
const rig = createDirector(body, { reduced });
const captions = createCaptions();

// ---- stage ----
const statusChip = h('button', { type: 'button', class: 'chip', 'data-state': 'connecting', 'data-testid': 'status', 'aria-live': 'off' }, LABELS.connecting);
const micButton = h('button', { type: 'button', class: 'mic', 'aria-label': 'Mute microphone', 'aria-pressed': 'false', 'data-testid': 'mic', hidden: true },
  s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    s('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }), s('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v4' })));
const robotCol = h('div', { class: 'robot-col' }, rig.el, h('div', { class: 'status' }, statusChip, micButton));
const startButton = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'start' }, 'Meet Juno');
const WELCOME = demo ? 'Demo mode: Juno runs from a script, no account needed.' : 'Juno is our in-store guide. Talk to Juno or use touch. Your browser will ask to use the microphone.';
const startText = h('p', { 'data-testid': 'start-text' }, WELCOME);
const startCard = h('div', { class: 'start', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Gizmo Grove', 'data-testid': 'start-overlay', 'data-phase': 'welcome' },
  h('div', { class: 'start-card' }, h('span', { class: 'eyebrow' }, 'Gizmo Grove'), h('h1', null, 'Welcome in.'), startText, startButton,
    h('span', { class: 'spinner', 'aria-hidden': 'true' })));
// While Juno joins, the card shrinks to a notice over her dimmed figure. She only looks present once she is.
const TITLES = { welcome: 'Welcome in.', joining: 'Juno is joining…', failed: 'Juno could not join.' };
function setPhase(phase, text) {
  startCard.dataset.phase = phase;
  stage.dataset.presence = phase === 'joining' ? 'joining' : 'away';
  startCard.querySelector('h1').textContent = TITLES[phase];
  startText.textContent = text ?? WELCOME;
  startCard.hidden = false;
  lock(true);
}
/** The card is modal: the page behind it cannot take focus or taps until it closes. @param {boolean} on */
function lock(on) { for (const el of stage.children) if (el !== startCard) el.toggleAttribute('inert', on); }
const stage = h('div', { class: 'stage', 'data-layout': 'wide', 'data-presence': 'away', 'data-kiosk': kioskMode ? '' : null, 'data-theme': light ? 'light' : null }, robotCol, null, captions.el, startCard);
if (accent) stage.style.setProperty('--accent', accent);

// Rendered after the bridge exists, because taps go through it.
let bridge = null;
const tap = (action) => (bridge ? bridge.tap(action) : store.dispatch(action));
const ask = (question) => bridge?.ask(question);
const panel = createPanel({ store, tap, ask });
stage.insertBefore(panel.el, captions.el);
lock(true);
document.body.append(stage);

// ---- size ----
let layout = 'wide';
function fit() {
  const vp = { width: innerWidth, height: innerHeight };
  layout = pickLayout(vp);
  stage.dataset.layout = layout;
  stage.style.fontSize = `${unitFor(layout, vp).fontPx}px`;
}
fit();
new ResizeObserver(fit).observe(document.documentElement);

// ---- one animation loop ----
let last = performance.now();
function frame(now) {
  rig.tick(Math.min(100, now - last));
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- status ----
function onStatus(state, detail) {
  statusChip.dataset.state = state;
  statusChip.textContent = detail && state === 'error' ? `${LABELS.error}: ${detail}` : LABELS[state];
  micButton.setAttribute('aria-pressed', String(state === 'muted' || !!bridge?.muted));
  // Turn changes are in the captions. Only a state the customer has to act on is announced.
  statusChip.setAttribute('aria-live', ['blocked', 'error', 'ended'].includes(state) ? 'polite' : 'off');
  if (state === 'ended' && kioskMode) backToStart();
}

// ---- session ----
let session = null;

async function loadSocketIo() {
  if (globalThis.io) return;
  await new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    el.integrity = 'sha384-2huaZvOR9iDzHqslqwpR87isEmrfxqyWOF7hr7BY6KG0+hVKLoEXMPUJw3ynWuhO';
    el.crossOrigin = 'anonymous';
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load socket.io'));
    document.head.append(el);
  });
}

// The SDK and socket.io load while the customer reads the welcome card. A failed load is tried again on the next start.
let libsPromise = null;
const loadLibs = () => (libsPromise ??= Promise.all([import('../../../src/experience/index.js'), loadSocketIo()]).then(([m]) => m).catch((e) => { libsPromise = null; throw e; }));

// A token is asked for as soon as the page opens, so a quick tap on "Meet Juno" skips that round trip. It is used once, only while fresh.
const TOKEN_FRESH_MS = 60_000;
let early = null;
const fetchInit = async () => {
  const res = await fetch('/appInit');
  if (!res.ok) throw new Error('The token server said no. Run the provision script first.');
  return res.json();
};
function takeInit() {
  const taken = early;
  early = null;
  return taken && Date.now() - taken.at < TOKEN_FRESH_MS ? taken.promise : fetchInit();
}
if (!demo) {
  loadLibs().catch(() => {});
  early = { at: Date.now(), promise: fetchInit() };
  early.promise.catch(() => {});
}

async function createLiveSession() {
  const [{ KalturaAvatarSession }, init] = await Promise.all([loadLibs(), takeInit()]);
  const video = h('video', { class: 'avatar-video', autoplay: true, playsinline: true, muted: false });
  const voice = h('audio', { class: 'avatar-voice', autoplay: true });
  rig.videoSlot.append(video);
  document.body.append(voice);
  return new KalturaAvatarSession({
    token: init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl,
    idleTimeoutMs: kioskMode ? 0 : undefined, // a kiosk stays up between visitors
    videoEl: video, audioEl: voice, socketFactory: (url, opts) => globalThis.io(url, opts),
    isFirefox: /firefox/i.test(navigator.userAgent), requestVars: buildVars(store.getState()),
  });
}

function dropSession() {
  bridge?.destroy(); // first, so the session's own `ended` does not come back here
  session?.disconnect?.();
  document.querySelectorAll('.avatar-video, .avatar-voice').forEach((el) => el.remove());
}

/** Kiosk: end the visit and show the welcome card, so the next visitor starts a new conversation. */
function backToStart() {
  dropSession();
  session = null;
  bridge = null;
  micButton.hidden = true;
  startButton.textContent = 'Meet Juno';
  setPhase('welcome');
}

const TRIES = 3;
async function startSession() {
  setPhase('joining', 'Setting up the connection. Allow the microphone if your browser asks.');
  onStatus('connecting');
  try {
    dropSession();
    // A live connection can drop on the first try (network, relay). Try again before showing an error: a kiosk has nobody to tap "Try again".
    await withRetry(async () => {
      session = demo ? new DemoSession({ speed: params.has('fast') ? 0.1 : 1 }) : await createLiveSession();
      bridge = createBridge({ session, store, body: rig, captions, onStatus, getLayout: () => layout });
      session.on('warning', (w) => { if (w?.code?.startsWith('mic_')) onStatus('muted'); });
      for (const e of ['userStartedTalking', 'avatarStartTalking']) session.on(e, () => kiosk?.poke());
      await session.connect();
    }, {
      tries: demo ? 1 : TRIES, delayMs: 400,
      before: (attempt) => { dropSession(); onStatus('connecting'); startText.textContent = `That did not work. Trying again (${attempt} of ${TRIES})…`; },
    });
    startCard.hidden = true;
    lock(false);
    stage.dataset.presence = 'here';
    bridge.start();
    micButton.hidden = false;
    micButton.focus({ preventScroll: true });
    if (demo) globalThis.__showroom = { store, session, rig };
  } catch (e) {
    onStatus('error', e?.detail || e?.message || String(e));
    startButton.textContent = 'Try again';
    setPhase('failed', 'Check your connection, then try again.');
  }
}

startButton.addEventListener('click', startSession);
micButton.addEventListener('click', () => { if (!bridge) return; bridge.setMuted(!bridge.muted); micButton.setAttribute('aria-pressed', String(bridge.muted)); });
statusChip.addEventListener('click', () => {
  if (statusChip.dataset.state === 'blocked') bridge?.resumePlayback();
  else if (statusChip.dataset.state === 'ended') startSession();
});

// A fresh visit: tell the agent the screen was reset.
store.subscribe((_n, _p, action) => {
  if (action.type === 'reset' && session?.connected !== false && bridge) Promise.resolve(session.speak('[The screen was reset for a new visit. Greet the customer briefly.]')).catch(() => {});
});

let kiosk = null;
if (kioskMode) {
  kiosk = createKiosk({ store, onReset: backToStart, idleMs: Number(params.get('idle')) || 90_000, warnMs: Number(params.get('warn')) || 15_000, onWarn: (on) => { if (on) captions.show('agent', 'Still there? Tap anywhere to keep going.'); else captions.clear(); } });
  setInterval(() => { if (store.getState().scene === 'welcome' && !rig.speaking) rig.perform('wave'); }, 25_000);
}

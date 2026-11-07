/**
 * Connects a session (real or demo) to the store and the body. No DOM here,
 * so the same code runs under unit tests with the demo session.
 *
 *  voice : session tool call  -> store actions -> UI
 *  touch : UI tap             -> store actions -> UI, plus a short note to the agent
 *  state : every store change -> request vars (`screen`, `cart`) -> agent
 */
import { TOOL_SPECS, argSchema, toActions } from './tools.js';
import { screenText, cartText, tapNote } from './vars.js';
import { presentDirection } from './layout.js';
import { CaptionService } from '../../../src/experience/captions.js';

/** Request variables for the agent. Also used as the session's join-time seed. @param {import('./reducer.js').State} state */
export const buildVars = (state) => ({ screen: screenText(state), cart: cartText(state.cart) });

/** Sent when the agent's own greeting has not started a moment after the connection is up. */
const INTRO_NOTE = '[The customer just arrived. Introduce yourself in one short sentence, then ask what brings them in.]';

/**
 * @typedef {{perform:(n:string,d?:string)=>void,setSpeaking:(b:boolean)=>void,setThinking:(b:boolean)=>void,setListening:(n:number)=>void,setLive:(b:boolean)=>void,userTalking?:()=>void,say?:(text:string)=>void}} Body
 * @typedef {'connecting'|'ready'|'listening'|'thinking'|'speaking'|'muted'|'blocked'|'error'|'ended'} Status
 * @param {{
 *   session: any, store: ReturnType<typeof import('./store.js').createStore>, body: Body,
 *   captions: {show:(who:'agent'|'user',text:string)=>void, clear:()=>void, announce:(text:string)=>void},
 *   onStatus?: (s:Status, detail?:string)=>void, getLayout?: ()=>import('./layout.js').Layout,
 *   noteDelayMs?: number, introWaitMs?: number,
 * }} deps
 */
export function createBridge({ session, store, body, captions, onStatus = () => {}, getLayout = () => 'wide', noteDelayMs = 450, introWaitMs = 5000 }) {
  const offs = [];
  let status = /** @type {Status} */ ('connecting');
  let speaking = false;
  let thinking = false;
  let noteTimer = 0;
  /** @type {string[]} */
  let pendingNotes = [];
  let varsQueued = false;
  let connected = false;
  let greeted = false; // the agent has started a turn (its own greeting, or a reply)
  let introTimer = 0;

  const setStatus = (s, detail) => { status = s; onStatus(s, detail); };
  let micOff = false; // the customer's own mute. The session has no flag to read back.
  const idle = () => (micOff ? 'muted' : 'listening');

  function pushVars() {
    if (!connected || varsQueued) return;
    varsQueued = true;
    queueMicrotask(() => {
      varsQueued = false;
      try { session.updateRequestVars(buildVars(store.getState())); } catch (e) { setStatus('error', e.detail || e.message); }
    });
  }

  // voice: one handler per tool
  for (const spec of TOOL_SPECS) {
    offs.push(session.onToolCall(spec.name, (args) => {
      const r = toActions(spec.name, args, store.getState());
      if ('error' in r) throw new Error(r.error);
      const before = store.getState().scene;
      for (const a of r.actions) store.dispatch(a);
      if (store.getState().scene !== before && store.getState().scene !== 'done') body.perform('present', presentDirection(getLayout()));
    }, argSchema(spec)));
  }

  // touch: same actions, plus a note so the agent can react
  function tap(action) {
    clearSuggestions();
    const prev = store.getState();
    const next = store.dispatch(action);
    const note = tapNote(prev, next, action);
    if (note) {
      pendingNotes.push(note);
      clearTimeout(noteTimer);
      noteTimer = setTimeout(sendNote, noteDelayMs);
    }
  }
  const clearSuggestions = () => store.dispatch({ type: 'suggest', questions: [] });
  /** The customer tapped a suggested question: it counts as something they said. @param {string} question */
  function ask(question) {
    clearSuggestions();
    captions.show('user', question);
    greeted = true;
    if (connected) Promise.resolve(session.speak(question)).catch(() => {});
  }
  function sendNote() {
    greeted = true;
    const text = pendingNotes.join(' ');
    pendingNotes = [];
    if (!text || !connected) return;
    Promise.resolve(session.speak(text)).catch(() => {});
  }

  offs.push(store.subscribe((next, prev) => {
    pushVars();
    if (next.scene === 'done' && prev.scene !== 'done') body.perform('celebrate');
  }));

  const on = (event, fn) => offs.push(session.on(event, fn));
  on('avatarStartTalking', () => { greeted = true; speaking = true; thinking = false; body.setSpeaking(true); body.setThinking(false); setStatus('speaking'); });
  on('avatarStopTalking', () => { speaking = false; body.setSpeaking(false); if (!thinking) setStatus(idle()); });
  on('responsePending', () => { greeted = true; thinking = true; body.setThinking(true); body.perform('think'); setStatus('thinking'); });
  on('responseSettled', () => { thinking = false; body.setThinking(false); if (!speaking) setStatus(idle()); });
  on('userStartedTalking', () => { greeted = true; body.perform('nod'); body.userTalking?.(); if (!speaking) setStatus('listening'); });
  on('localMicLevel', ({ level }) => body.setListening(level));
  on('turnStart', (p) => { if (p?.isNewTurn) clearSuggestions(); }); // chips belong to the answer before
  on('interrupted', () => { speaking = false; body.setSpeaking(false); if (!thinking) setStatus(idle()); });
  on('mediaReady', ({ mode }) => { if (mode === 'video') body.setLive(true); });
  // Agent captions come from the SDK's CaptionService (timed to the audio, split on word
  // boundaries). The final transcript is the clean full sentence, kept for screen readers only.
  const captionService = new CaptionService(session, { holdAfterEndMs: 2500, maxLines: 2 });
  offs.push(captionService.onCaption(({ text, clear }) => { if (clear) captions.clear(); else captions.show('agent', text); }));
  on('transcript', ({ text, type }) => { if (type === 'user') captions.show('user', text); else if (type === 'final') { captions.announce(text); body.say?.(text); } });
  on('warning', (w) => { if (w?.code === 'playback_blocked') setStatus('blocked'); });
  on('error', (e) => setStatus('error', e?.detail || e?.message));
  on('ended', () => setStatus('ended'));
  // Reliability signals. The SDK recovers by itself. These lines tell the customer why Juno is slow.
  on('brainStalled', () => captions.show('agent', 'One moment, still working on that.'));
  on('toolSpiralDetected', () => captions.show('agent', 'Let me try that a different way.'));
  on('toolSpiralRecovering', () => { setStatus('connecting'); captions.show('agent', 'Reconnecting. I will pick up where we left off.'); });
  on('toolCallInvalid', ({ call, errors }) => captions.show('agent', `(${call.name}: ${errors.join(', ')})`));

  return {
    /**
     * Call once `session.connect()` has resolved. Shows "ready" and waves. The agent greets by itself;
     * if its greeting has not begun after `introWaitMs`, Juno is asked to introduce herself.
     */
    start() {
      connected = true;
      body.perform('wave');
      if (!greeted) {
        setStatus('ready');
        introTimer = setTimeout(() => {
          if (greeted) return;
          greeted = true;
          Promise.resolve(session.speak(INTRO_NOTE)).catch(() => {});
          if (status === 'ready') setStatus(idle());
        }, introWaitMs);
      }
      pushVars();
    },
    tap,
    ask,
    /** Mute or unmute the mic. @param {boolean} on */
    setMuted(on) { micOff = on; if (on) session.mute(); else session.unmute(); if (!speaking && !thinking) setStatus(idle()); },
    /** Retry blocked playback. Needs a user gesture. */
    async resumePlayback() { await session.startPlayback(); setStatus(idle()); },
    get status() { return status; },
    /** True while the customer has the mic off. */
    get muted() { return micOff; },
    destroy() { clearTimeout(noteTimer); clearTimeout(introTimer); captionService.destroy(); for (const off of offs) off?.(); offs.length = 0; },
  };
}

/**
 * Decides when the body moves. It wraps a body (clip body or SVG rig) and keeps its contract, so the bridge
 * talks to the director as if it were the body. Real moves (`perform`) pass straight through. The director adds
 * the unprompted ones, and every timing and pick comes from `rng`, so a test can replay a run.
 *
 *   speaking   a hand gesture now and then (not every pause, never the same one twice in a row),
 *              small head nods on the stressed beats, an open-hand gesture after a question
 *   listening  slow nods while the customer talks, a head tilt held while they think aloud
 *   waiting    a slow head tilt or nod every few seconds, and a drifting idle loop rate
 *   thinking   a head tilt, held until the answer starts
 *
 * Gestures stop when speech stops, so hands never keep waving over a quiet room.
 */

/** Hand gestures for talking, with a base weight. */
const TALKING = { beat: 3, beat2: 3, shrug: 0.5 };
/** Open hands suit a question or an offer. */
const OPEN = { shrug: 1 };

const between = (rng, lo, hi) => lo + rng() * (hi - lo);

/**
 * @param {object} body A body with perform, release, busy, cue, drift, tick, setSpeaking, setThinking, setListening, setLive.
 * @param {{rng?:()=>number, reduced?:boolean}} [opts]
 */
export function createDirector(body, { rng = Math.random, reduced = false } = {}) {
  /** @type {'waiting'|'speaking'|'thinking'} */
  let mode = 'waiting';
  let userTalkMs = 0; // how much longer the customer counts as talking
  let tiltHeld = false;
  let gestureIn = 0; // ms until the next hand gesture is considered
  let cueIn = 0; // ms until the next head move
  let driftIn = between(rng, 4000, 9000);
  const recent = []; // the last hand gestures, newest last
  let question = false; // the last thing she said was a question
  let started = ''; // the hand gesture this director started for speech

  const side = () => (rng() < 0.5 ? -1 : 1);
  const tilt = (amount = between(rng, 0.5, 1)) => { body.cue?.('tilt', amount, side()); tiltHeld = true; };
  const level = () => { if (tiltHeld) { body.cue?.('level'); tiltHeld = false; } };

  /** Pick a hand gesture by weight. The one just used is out, the one before it half as likely. */
  function pick() {
    const weights = { ...TALKING };
    if (question) for (const [k, v] of Object.entries(OPEN)) weights[k] = (weights[k] ?? 0) + v * 14;
    const [last, before] = [recent.at(-1), recent.at(-2)];
    if (last in weights) weights[last] = 0; // never the same one twice in a row
    if (before in weights) weights[before] *= 0.5;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (const [k, v] of Object.entries(weights)) { r -= v; if (r <= 0) return k; }
    return 'beat';
  }

  function speakingStep() {
    if (gestureIn <= 0) {
      if (body.busy) gestureIn = 500;
      else if (!question && rng() < 0.3) gestureIn = between(rng, 2400, 4600); // a pause with the hands still
      else {
        const name = pick();
        if (body.perform(name, 'right', { rate: between(rng, 0.8, 0.95), length: between(rng, 1.8, 3.4) })) {
          started = name;
          recent.push(name);
          if (recent.length > 4) recent.shift();
          question = false;
        }
        gestureIn = between(rng, 4200, 8800);
      }
    }
    if (cueIn <= 0) {
      if (question && !tiltHeld) tilt(0.6);
      else if (rng() < 0.55) body.cue?.('nod', between(rng, 0.4, 0.8));
      else if (tiltHeld) level();
      else tilt(0.5);
      cueIn = between(rng, 2200, 4800);
    }
  }

  function listeningStep() {
    if (cueIn <= 0) {
      if (rng() < 0.6) body.cue?.('nod', between(rng, 0.3, 0.6));
      if (!tiltHeld && rng() < 0.4) tilt(0.5);
      cueIn = between(rng, 2600, 4800);
    }
  }

  function waitingStep() {
    if (cueIn > 0) return;
    const r = rng();
    if (tiltHeld) level();
    else if (r < 0.55) tilt(between(rng, 0.3, 0.7));
    else if (r < 0.8) body.cue?.('nod', between(rng, 0.3, 0.6));
    cueIn = between(rng, 5000, 11000);
  }

  return Object.assign(Object.create(body), {
    /** Real moves pass through. @param {string} name @param {'right'|'up'|'down'} [dir] */
    perform(name, dir) {
      if (name !== 'nod') started = '';
      return body.perform(name, dir);
    },
    setSpeaking(on) {
      body.setSpeaking(on);
      if (on) {
        mode = 'speaking';
        userTalkMs = 0;
        level();
        gestureIn = between(rng, 900, 1700);
        cueIn = between(rng, 500, 1100);
      } else {
        // Hands stop when the voice does, unless a real move (a scene change, a wave) is playing.
        if (started && body.busy) body.release?.();
        started = '';
        mode = 'waiting';
        cueIn = between(rng, 2500, 6000);
      }
    },
    setThinking(on) {
      body.setThinking(on);
      if (reduced) return;
      if (on) { mode = 'thinking'; userTalkMs = 0; tilt(0.8); } else if (mode === 'thinking') { mode = 'waiting'; level(); cueIn = between(rng, 2500, 6000); }
    },
    /** The customer started talking. */
    userTalking() {
      if (mode === 'speaking') return;
      if (userTalkMs <= 0) cueIn = between(rng, 700, 1300);
      userTalkMs = 3500;
    },
    /** The text of her next turn. A question gets an open hand and a head tilt. @param {string} text */
    say(text) {
      question = /\?/.test(String(text));
    },
    tick(dtMs) {
      body.tick(dtMs);
      if (reduced) return;
      gestureIn -= dtMs; cueIn -= dtMs; driftIn -= dtMs; userTalkMs -= dtMs;
      if (mode === 'speaking') speakingStep();
      else if (mode === 'thinking') { /* the tilt holds until the answer starts */ } else if (userTalkMs > 0) listeningStep();
      else waitingStep();
      if (driftIn <= 0) { body.drift?.(between(rng, 0.9, 1.08)); driftIn = between(rng, 6000, 14000); }
    },
  });
}

/**
 * Juno's body: a procedural SVG robot driven by springs and gesture data.
 * The live avatar `<video>` sits inside the head's visor.
 *
 * Contract (the "Body" seam): anything with this shape can replace the rig,
 * for example a body made of packed-alpha video clips.
 *   el, videoSlot, perform(name, dir), setSpeaking(on), setThinking(on),
 *   setListening(level 0..1), setLive(on), tick(dtMs), destroy()
 */
import { h, s } from '../dom.js';
import { createSpring } from './spring.js';
import { REST, HEAD_ONLY, gesture, createSequencer } from './gestures.js';

const JOINTS = ['lA', 'lE', 'rA', 'rE', 'tilt', 'nod', 'lean'];

/** @param {number} n */
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Pearl and dark gradients shared by every part. */
function defs() {
  const grad = (id, a, b, vertical = true) => s('linearGradient', { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 },
    s('stop', { offset: '0%', 'stop-color': a }), s('stop', { offset: '100%', 'stop-color': b }));
  return s('defs', null,
    grad('jg-pearl', '#ffffff', '#c9d1e6'),
    grad('jg-pearl-h', '#e4e9f6', '#ffffff', false),
    grad('jg-dark', '#3a4160', '#1a1e33'),
    s('radialGradient', { id: 'jg-glow', cx: '50%', cy: '50%', r: '50%' },
      s('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': 0.55 }),
      s('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': 0 })),
  );
}

/** One arm, drawn hanging down with its shoulder at the origin. */
function arm(side) {
  const pearl = { fill: 'url(#jg-pearl-h)', stroke: 'rgba(40,50,90,.18)', 'stroke-width': 1.5 };
  const hand = s('g', null,
    s('rect', { x: -27, y: 104, width: 54, height: 62, rx: 27, ...pearl }),
    s('rect', { x: side === 'l' ? 14 : -30, y: 120, width: 16, height: 30, rx: 8, fill: '#dfe4f2' }),
    s('rect', { x: -14, y: 150, width: 28, height: 6, rx: 3, fill: 'var(--accent)', opacity: 0.8 }));
  const fore = s('g', { class: `fore-${side}`, transform: 'translate(0 130)' },
    s('rect', { x: -19, y: -4, width: 38, height: 118, rx: 19, ...pearl }), hand);
  return s('g', { class: `arm-${side}` },
    s('rect', { x: -22, y: -12, width: 44, height: 146, rx: 22, ...pearl }),
    s('circle', { cx: 0, cy: 130, r: 25, fill: 'url(#jg-dark)' }),
    s('circle', { cx: 0, cy: 130, r: 9, fill: 'var(--accent)', opacity: 0.9 }),
    fore);
}

function bodySvg() {
  const shoulder = (cx) => s('g', null, s('circle', { cx, cy: 470, r: 40, fill: 'url(#jg-dark)' }), s('circle', { cx, cy: 470, r: 14, fill: 'var(--accent)', opacity: 0.85 }));
  return s('svg', { class: 'rig-body', viewBox: '0 0 600 1000', 'aria-hidden': 'true', focusable: 'false' },
    defs(),
    s('ellipse', { cx: 300, cy: 925, rx: 210, ry: 40, fill: 'url(#jg-glow)', class: 'rig-hover-glow' }),
    s('g', { class: 'rig-float' },
      s('ellipse', { cx: 300, cy: 905, rx: 128, ry: 24, fill: 'url(#jg-dark)' }),
      s('ellipse', { cx: 300, cy: 898, rx: 112, ry: 16, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 4, opacity: 0.9, class: 'rig-ring' }),
      s('path', { d: 'M236 700 L364 700 L346 884 Q300 904 254 884 Z', fill: 'url(#jg-dark)' }),
      s('g', { class: 'rig-torso' },
        s('rect', { x: 188, y: 418, width: 224, height: 310, rx: 92, fill: 'url(#jg-pearl)', stroke: 'rgba(40,50,90,.2)', 'stroke-width': 2 }),
        s('rect', { x: 236, y: 504, width: 128, height: 86, rx: 26, fill: '#12162a' }),
        s('path', { class: 'rig-pulse', d: 'M250 548 H284 L294 524 L308 574 L320 540 H350', fill: 'none', stroke: 'var(--accent)', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        s('circle', { cx: 300, cy: 650, r: 26, fill: 'var(--accent)' }),
        s('text', { x: 300, y: 661, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 800, fill: '#fff', 'font-family': 'system-ui, sans-serif' }, 'G'),
        s('rect', { x: 268, y: 396, width: 64, height: 34, rx: 12, fill: 'url(#jg-dark)' }),
        s('g', { class: 'rig-shoulders' }, shoulder(176), shoulder(424)),
        s('g', { class: 'rig-arm-l', transform: 'translate(176 470)' }, arm('l')),
        s('g', { class: 'rig-arm-r', transform: 'translate(424 470)' }, arm('r')))),
  );
}

function headEl() {
  const shell = s('svg', { class: 'rig-head-back', viewBox: '0 0 300 290', style: { overflow: 'visible' }, 'aria-hidden': 'true', focusable: 'false' },
    s('line', { x1: 150, y1: 8, x2: 150, y2: -30, stroke: '#aab3cc', 'stroke-width': 6, 'stroke-linecap': 'round' }),
    s('circle', { class: 'rig-bulb', cx: 150, cy: -40, r: 15, fill: 'var(--accent)' }),
    s('circle', { cx: 8, cy: 150, r: 28, fill: 'url(#jg-dark)' }), s('circle', { cx: 292, cy: 150, r: 28, fill: 'url(#jg-dark)' }),
    s('circle', { cx: 8, cy: 150, r: 10, fill: 'var(--accent)', opacity: 0.85 }), s('circle', { cx: 292, cy: 150, r: 10, fill: 'var(--accent)', opacity: 0.85 }),
    s('rect', { x: 6, y: 0, width: 288, height: 290, rx: 96, fill: 'url(#jg-pearl)', stroke: 'rgba(40,50,90,.22)', 'stroke-width': 2 }),
    s('rect', { x: 34, y: 38, width: 232, height: 232, rx: 74, fill: '#0b0e1a' }));
  const eyes = h('div', { class: 'rig-eyes', 'aria-hidden': 'true' }, h('i'), h('i'), h('b'));
  const slot = h('div', { class: 'rig-visor' }, eyes);
  const front = s('svg', { class: 'rig-head-front', viewBox: '0 0 300 290', 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { class: 'rig-mic-ring', x: 34, y: 38, width: 232, height: 232, rx: 74, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 7 }),
    s('rect', { x: 34, y: 38, width: 232, height: 232, rx: 74, fill: 'none', stroke: 'rgba(10,14,30,.9)', 'stroke-width': 3 }),
    s('path', { d: 'M62 70 Q150 40 238 70 L238 108 Q150 80 62 108 Z', fill: '#fff', opacity: 0.1 }));
  const head = h('div', { class: 'rig-head' }, shell, slot, front);
  return { head, slot };
}

/**
 * @param {{reduced?:boolean}} [opts] `reduced`: honour reduced motion (no idle sway, gestures snap).
 */
export function createRig({ reduced = false } = {}) {
  const { head, slot } = headEl();
  const body = bodySvg();
  const root = h('div', { class: 'rig', 'data-live': 'false', 'data-speaking': 'false', 'data-thinking': 'false' }, body, head);

  const springs = Object.fromEntries(JOINTS.map((j) => [j, createSpring(REST[j], reduced ? { stiffness: 500, damping: 45 } : { stiffness: 140, damping: 15 })]));
  const seq = createSequencer((pose) => { for (const [k, v] of Object.entries(pose)) if (springs[k]) springs[k].target = v; });
  const q = (sel) => /** @type {SVGElement} */ (body.querySelector(sel));
  const armL = q('.rig-arm-l'); const armR = q('.rig-arm-r');
  const foreL = q('.fore-l'); const foreR = q('.fore-r');
  const torso = q('.rig-torso'); const float = q('.rig-float');
  const pulse = q('.rig-pulse');
  const bulbEl = head.querySelector('.rig-bulb');
  const ringEl = head.querySelector('.rig-mic-ring');

  let t = 0; let speaking = false; let thinking = false; let level = 0; let levelSmooth = 0;

  const rig = {
    el: root,
    /** Mount point for the avatar `<video>`. */
    videoSlot: slot,
    /** @param {string} name @param {'right'|'up'|'down'} [dir] */
    perform(name, dir = 'right') {
      if (reduced && !HEAD_ONLY.has(name)) return false;
      const g = gesture(name, dir);
      seq.play(g);
      return g !== null;
    },
    /** Bring the arms back to rest. */
    release() { seq.play({ name: 'release', keys: [{ at: 0, pose: { ...REST } }] }); },
    /** True while an arm gesture is running. */
    get busy() { return seq.armBusy; },
    /** A small head move. @param {'nod'|'tilt'|'level'} name @param {number} [amount] @param {-1|1} [side] */
    cue(name, amount = 1, side = 1) {
      if (reduced) return;
      if (name === 'nod') seq.play(gesture('nod'));
      else springs.tilt.target = name === 'tilt' ? amount * side * 4 : 0;
    },
    drift() {},
    /** @param {boolean} on */
    setSpeaking(on) { speaking = on; root.dataset.speaking = String(on);  },
    /** @param {boolean} on */
    setThinking(on) { thinking = on; root.dataset.thinking = String(on); },
    /** @param {number} v 0..1 */
    setListening(v) { level = clamp01(v); },
    /** True once the live video has its first frame: the visor shows the face, not the loading eyes. @param {boolean} on */
    setLive(on) { root.dataset.live = String(on); },
    get speaking() { return speaking; },
    /** @param {number} dtMs */
    tick(dtMs) {
      const dt = dtMs / 1000;
      t += dt;
      seq.tick(dtMs);
      for (const j of JOINTS) springs[j].step(dt);
      levelSmooth += (level - levelSmooth) * Math.min(1, dt * 12);
      const idle = reduced ? 0 : 1;
      const breathe = Math.sin(t * 1.7) * 2.2 * idle;
      const hover = Math.sin(t * 1.1) * 7 * idle;
      const talk = speaking && !reduced ? 1 : 0;
      const tilt = springs.tilt.value + (Math.sin(t * 2.3) * 0.9 + Math.sin(t * 5.1) * 0.5) * talk + Math.sin(t * 0.6) * 0.6 * idle;
      const nod = springs.nod.value + Math.sin(t * 7.3) * 1.4 * talk + (thinking ? -3 : 0);
      armL.setAttribute('transform', `translate(176 470) rotate(${springs.lA.value.toFixed(2)})`);
      armR.setAttribute('transform', `translate(424 470) rotate(${(-springs.rA.value).toFixed(2)})`);
      foreL.setAttribute('transform', `translate(0 130) rotate(${springs.lE.value.toFixed(2)})`);
      foreR.setAttribute('transform', `translate(0 130) rotate(${(-springs.rE.value).toFixed(2)})`);
      torso.setAttribute('transform', `rotate(${(springs.lean.value + breathe * 0.1).toFixed(2)} 300 720) translate(0 ${breathe.toFixed(2)})`);
      float.setAttribute('transform', `translate(0 ${hover.toFixed(2)})`);
      root.style.setProperty('--hover', `${hover.toFixed(2)}`);
      head.style.transform = `translate(0, ${(((hover + breathe + nod) / 290) * 100).toFixed(3)}%) rotate(${tilt.toFixed(2)}deg)`;
      const glow = 0.45 + levelSmooth * 0.55 + (thinking ? (Math.sin(t * 6) * 0.5 + 0.5) * 0.4 : 0);
      bulbEl.style.opacity = String(clamp01(glow));
      bulbEl.style.filter = `drop-shadow(0 0 ${(4 + levelSmooth * 14).toFixed(1)}px var(--accent))`;
      ringEl.style.opacity = String((0.12 + levelSmooth * 0.88).toFixed(3));
      pulse.style.opacity = String(speaking ? 0.55 + Math.sin(t * 9) * 0.45 : 0.5 + Math.sin(t * 2) * 0.2 * idle);
    },
    destroy() { root.remove(); },
  };
  return rig;
}

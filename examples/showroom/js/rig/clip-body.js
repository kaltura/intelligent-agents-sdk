/**
 * A body made of video clips, with the live avatar video in the head area.
 * This is the technique for a photoreal full-body figure: an idle loop that
 * always plays, plus short gesture clips that play over it and then fade out.
 * Same contract as the SVG rig (see rig.js), so `main.js` swaps one for the other.
 *
 * A body is a folder with a `manifest.json`:
 *   { "aspect": [600, 1000],
 *     "head": { "left": 0.25, "top": 0.14, "width": 0.5, "height": 0.2 },   fractions of the frame
 *     "seam": [0.22, 0.25],     rows (fractions of the frame height): the footage is solid from the first, and the live head fades out over the first half of that band
 *     "matte": "head-matte.png", the head's silhouette as the alpha of a PNG, the size of the live video. It cuts the head out of its backdrop
 *     "still": "head.jpg",      optional: the live avatar's first frame, shown until a session is live
 *     "idle": "idle",
 *     "packed": true,           required: each clip holds the picture on top and its alpha matte below (twice the frame height)
 *     "tracked": true,          optional: each clip has an `x.track.json` with the neck motion per frame
 *     "fit": { "scale": 0.86, "dx": 0.0056, "dy": -0.0056 },   optional: size and place the live head on the footage body (dx, dy as a fraction of the frame width)
 *     "mirror": true,           optional: draw the whole figure, live head included, as a mirror image, so a gesture that points away from the scene panel points into it. `fit` stays as authored for the unflipped figure
 *     "floor": { "y": 0.943, "width": 0.4 },   optional: where the soles are (fraction of the frame height) and how wide the feet stand (fraction of the frame width). Draws a soft contact shadow there
 *     "joins": "joins.json",    optional: where each gesture can join the idle loop without a visible cut (see joins.js). A gesture then starts and ends on frames that match the idle pose. Without it, gestures cross-fade
 *     "clips": { "wave": "wave", "present-right": "present-right", ... } }
 * Each clip name `x` is served as `x.webm` and `x.mp4`. The browser takes the first it can play.
 * A track is `{ "fps": 24, "frames": [[dx, dy, rotation], ...] }`: the neck's shift as a fraction of the frame width
 * and its tilt in radians (clockwise positive). The live head moves with it, so it stays on the neck as the body sways.
 * A WebGL canvas draws the clips: colour from the top half, alpha from the bottom half, so edges are smooth
 * and need no black background. The head area of every clip is transparent. The live video fills it, cut out by the `matte`,
 * and fades out across the `seam` rows over the solid footage, so head and body read as one figure on any scene.
 * Without WebGL, `createClipBody` throws and the page falls back to the SVG robot.
 */
import { h } from '../dom.js';
import { createLayers } from './layers.js';
import { ahead, parseJoins, planEntry, planExit } from './joins.js';
import { createSpring } from './spring.js';

/** Gesture names the app asks for. A body may implement any subset. */
export const GESTURES = ['wave', 'present', 'beat', 'beat2', 'think', 'celebrate', 'shrug', 'nod'];

/**
 * Check a manifest and return it, or throw with a message that says what to fix.
 * @param {any} m
 */
export function parseManifest(m) {
  const fail = (why) => { throw new Error(`Body manifest: ${why}`); };
  if (!m || typeof m !== 'object') fail('not an object.');
  const [w, hgt] = Array.isArray(m.aspect) ? m.aspect : [];
  if (!(w > 0 && hgt > 0)) fail('"aspect" must be [width, height].');
  const box = m.head || {};
  for (const k of ['left', 'top', 'width', 'height']) if (!(box[k] >= 0 && box[k] <= 1)) fail(`"head.${k}" must be a number from 0 to 1.`);
  if (box.left + box.width > 1 || box.top + box.height > 1) fail('"head" must fit inside the frame.');
  const [a, b] = Array.isArray(m.seam) ? m.seam : [];
  if (!(a >= box.top && b > a && b <= box.top + box.height)) fail('"seam" must be [top, bottom] rows inside the head area, top above bottom.');
  if (typeof m.matte !== 'string' || !m.matte) fail('"matte" must name the head silhouette PNG. Rebuild the body with scripts/build-showroom-body.mjs --matte.');
  if (m.still !== undefined && (typeof m.still !== 'string' || !m.still)) fail('"still" must be a file name.');
  if (m.packed !== true) fail('"packed" must be true. Rebuild the body with scripts/build-showroom-body.mjs.');
  if (typeof m.idle !== 'string' || !m.idle) fail('"idle" must name the loop clip.');
  const clips = m.clips && typeof m.clips === 'object' ? m.clips : {};
  for (const [k, v] of Object.entries(clips)) if (typeof v !== 'string' || !v) fail(`clip "${k}" needs a file name.`);
  const fit = { scale: 1, dx: 0, dy: 0, ...(m.fit ?? {}) };
  if (!(fit.scale >= 0.5 && fit.scale <= 1.5)) fail('"fit.scale" must be from 0.5 to 1.5.');
  for (const k of ['dx', 'dy']) if (!(Math.abs(fit[k]) <= 0.1)) fail(`"fit.${k}" must be from -0.1 to 0.1.`);
  let floor = null;
  if (m.floor !== undefined) {
    const { y, width } = m.floor ?? {};
    if (!(y > 0 && y <= 1 && width > 0 && width <= 1)) fail('"floor" must be { y, width }, each from 0 to 1.');
    floor = { y, width };
  }
  if (m.joins !== undefined && (typeof m.joins !== 'string' || !m.joins)) fail('"joins" must be a file name.');
  return { aspect: [w, hgt], head: box, seam: [a, b], matte: m.matte, still: m.still ?? null, idle: m.idle, tracked: m.tracked === true, mirror: m.mirror === true, fit, floor, clips, joins: m.joins ?? null };
}

/**
 * The neck's [dx, dy, rotation] at a time. Linear between frames, held at both ends.
 * @param {{fps:number, frames:number[][]}} track @param {number} t seconds
 * @returns {number[]}
 */
export function sampleTrack(track, t) {
  const { frames, fps } = track;
  const p = Math.max(0, Math.min(frames.length - 1, t * fps));
  const i = Math.floor(p);
  const [a, b, f] = [frames[i], frames[Math.min(frames.length - 1, i + 1)], p - i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Check a track file and return it, or null. @param {any} t */
export function parseTrack(t) {
  const ok = t && t.fps > 0 && Array.isArray(t.frames) && t.frames.length > 0 && t.frames.every((f) => Array.isArray(f) && f.length === 3 && f.every(Number.isFinite));
  return ok ? { fps: t.fps, frames: t.frames } : null;
}

/** Pick the clip for a gesture: `name-dir` first, then `name`. @param {Record<string,string>} clips */
export const clipFor = (clips, name, dir) => clips[`${name}-${dir}`] ?? clips[name] ?? null;

function video(base, names, { loop = false } = {}) {
  const el = h('video', { class: 'clip', muted: true, playsinline: true, preload: 'auto', 'aria-hidden': 'true', tabindex: '-1' });
  el.muted = true;
  el.loop = loop;
  el.disablePictureInPicture = true;
  for (const [file, type] of names) el.append(h('source', { src: `${base}/${file}`, type }));
  return el;
}
const sources = (name) => [[`${name}.webm`, 'video/webm; codecs="vp9"'], [`${name}.mp4`, 'video/mp4']];

const VERT = `attribute vec2 p; varying vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
// Colour is the top half of the video, alpha the bottom half. Both are kept half a texel from the join, so linear filtering never mixes them.
const FRAG = `precision mediump float; uniform sampler2D t; uniform float g; uniform float e; varying vec2 uv;
void main() {
  vec3 c = texture2D(t, vec2(uv.x, clamp(uv.y * 0.5, e, 0.5 - e))).rgb;
  float a = texture2D(t, vec2(uv.x, clamp(0.5 + uv.y * 0.5, 0.5 + e, 1.0 - e))).r;
  gl_FragColor = vec4(c * a, a) * g;
}`;

/**
 * Draws packed clip videos (colour over matte) on a canvas with WebGL. Throws when WebGL is missing.
 * A video is uploaded only when its frame changed, and a draw only happens when something changed.
 * @param {HTMLCanvasElement} canvas
 */
export function createCompositor(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error('WebGL is not available.');
  const shader = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(sh)}`); return sh; };
  let uAlpha = null;
  let uEdge = null;
  /** Build the program and buffers. Runs again when the browser gives the GPU context back after losing it. */
  const setup = () => {
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Shader: ${gl.getProgramInfoLog(prog)}`);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    [uAlpha, uEdge] = [gl.getUniformLocation(prog, 'g'), gl.getUniformLocation(prog, 'e')];
    gl.enable(gl.BLEND);
    // Layers are weighted (their opacities sum to 1), so they add. Normal alpha-over would let the scene show through for a moment mid-crossfade.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  setup();
  /** @type {Map<HTMLVideoElement, {tex:WebGLTexture, time:number, sized:boolean}>} */
  const states = new Map();
  let key = '';
  // A browser can take the GPU context away (memory pressure, a driver reset, a tab in the background). The canvas goes blank until it is rebuilt.
  let lost = false;
  canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener?.('webglcontextrestored', () => { states.clear(); key = ''; setup(); lost = false; });
  return {
    /** Match the canvas to its on-screen size. Returns true when it changed. @param {number} w @param {number} hgt */
    resize(w, hgt) {
      if (canvas.width === w && canvas.height === hgt) return false;
      canvas.width = w; canvas.height = hgt; if (!lost) gl.viewport(0, 0, w, hgt); key = '';
      return true;
    },
    /**
     * Draw the layers, each with its own opacity (they add, so weights that sum to 1 keep the figure solid). Skips the work when nothing changed.
     * `time` is the media time of the frame on screen, so a new frame is uploaded exactly when one arrives (default: `currentTime`).
     * @param {Array<{video:HTMLVideoElement, alpha:number, time?:number}>} layers
     */
    draw(layers) {
      if (lost) return;
      let fresh = false;
      for (const { video: v, alpha, time = v.currentTime } of layers) {
        if (alpha <= 0 || v.seeking || v.readyState < 2 || !v.videoWidth) continue; // a hidden layer needs no upload, and a seeking one has no new frame yet
        let st = states.get(v);
        if (!st) {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          for (const [k, val] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
          st = { tex, time: -1 };
          states.set(v, st);
        }
        if (st.time !== time) {
          gl.bindTexture(gl.TEXTURE_2D, st.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
          st.time = time; fresh = true;
        }
      }
      const next = layers.map(({ alpha }) => alpha.toFixed(3)).join();
      if (!fresh && next === key) return;
      key = next;
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const { video: v, alpha } of layers) {
        const st = states.get(v);
        if (!st || alpha <= 0 || st.time < 0) continue;
        gl.bindTexture(gl.TEXTURE_2D, st.tex);
        gl.uniform1f(uAlpha, alpha);
        gl.uniform1f(uEdge, 0.5 / v.videoHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
    /** True while the GPU context is gone (a test hook). */
    get lost() { return lost; },
    destroy() { for (const st of states.values()) gl.deleteTexture(st.tex); states.clear(); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}

/**
 * @param {{base:string, manifest:object, reduced?:boolean, tracks?:Record<string,{fps:number, frames:number[][]}>, joins?:object|null}} opts
 *   `base` is the folder URL that holds the clips. `tracks` maps a clip name to its neck track. `joins` is the parsed `joins.json`.
 */
export function createClipBody({ base, manifest, reduced = false, tracks = {}, joins: joinsFile = null }) {
  const m = parseManifest(manifest);
  const joins = parseJoins(joinsFile);
  const [aw, ah] = m.aspect;
  // The media time of the frame each clip is showing. `currentTime` runs ahead of the picture, so the head would lead the body by a frame or two.
  const shownAt = new WeakMap();
  // A paused video shows the frame at `currentTime`, and may not report a new frame after a seek.
  const frameTime = (v) => (v.paused ? v.currentTime : (shownAt.get(v) ?? v.currentTime));
  const watch = (v) => {
    if (!v.requestVideoFrameCallback) return;
    const on = (_now, meta) => { shownAt.set(v, meta.mediaTime); v.requestVideoFrameCallback(on); };
    v.requestVideoFrameCallback(on);
    v.addEventListener('emptied', () => shownAt.delete(v));
  };
  const idle = video(base, sources(m.idle), { loop: true });
  idle.classList.add('clip-idle');
  // Two gesture videos take turns, so a new gesture loads while the one on screen keeps playing (see layers.js).
  const overs = [0, 1].map(() => {
    const el = h('video', { class: 'clip clip-over', muted: true, playsinline: true, preload: 'auto', 'aria-hidden': 'true', tabindex: '-1' });
    el.muted = true;
    el.disablePictureInPicture = true;
    return el;
  });
  // A short fade is enough: a gesture starts and ends on a frame that looks like the idle pose (see joins.js).
  const layers = createLayers({ fadeMs: 120 });
  const FPS = joins?.fps ?? 24;
  const SEEK_LEAD = 8; // frames of idle loop to leave for seeking a clip to its first frame
  const EXIT_LEAD = 14; // frames before an exit to start seeking the idle loop
  const GESTURE_FRAMES = 3.5 * FPS; // how long a gesture plays when the caller does not say
  /**
   * The gesture in hand, one at a time. `stage`:
   *   load   the clip is loading into its slot, paused
   *   seek   it is seeking to the frame that matches the idle pose
   *   armed  it waits for the idle loop to reach that pose
   *   play   it is on screen, and an exit is planned
   *   leave  it is fading out
   * @type {{clip:string, rate:number, frames:number, i:number, stage:string, age:number, stall:number, plan:any, exit:any, idleSeeked:boolean, primed:boolean, k0:number}|null}
   */
  let job = null;
  /** The next gesture, started once the current one has handed back to the idle loop. */
  let queued = null;
  let lastSlot = 1;
  watch(idle);
  overs.forEach(watch);
  const slot = h('div', { class: 'rig-visor' });
  const place = (el, p) => { el.style.left = `${(m.mirror ? 1 - p.left - p.width : p.left) * 100}%`; el.style.top = `${p.top * 100}%`; el.style.width = `${p.width * 100}%`; el.style.height = `${p.height * 100}%`; };
  place(slot, m.head);
  // The head is scaled about the neck (the bottom of the seam) and moved by `fit`. Rows below are in the head area's own space.
  const pivot = m.seam[1];
  // The live video fades out over the seam rows. Each row is mapped back through the fit, so the fade lands on the rows where the footage is solid.
  const own = (row) => ((pivot + (row - pivot - m.fit.dy * (aw / ah)) / m.fit.scale - m.head.top) / m.head.height) * 100;
  const seam = m.seam.map((row) => own(row) / 100);
  const matte = typeof document === 'undefined' ? null : Object.assign(document.createElement('img'), { src: new URL(`${base}/${m.matte}`, globalThis.location?.href ?? 'http://localhost/').href });
  slot.style.setProperty('--hs', String(m.fit.scale));
  const rootStyle = {};
  if (m.floor) Object.assign(rootStyle, { '--floor-y': `${m.floor.y * 100}%`, '--floor-w': `${m.floor.width * 100}%` });
  if (m.still) slot.append(h('img', { class: 'rig-still', src: `${base}/${m.still}`, alt: '', draggable: 'false', 'aria-hidden': 'true' }));
  const headCanvas = h('canvas', { class: 'rig-head-canvas', 'aria-hidden': 'true' });
  slot.append(headCanvas);
  const hctx = headCanvas.getContext?.('2d') ?? null;
  let drawn = ''; // what the head canvas shows now: source, its frame time and size
  let liveShown = false; // the head canvas has shown a live frame
  const canvas = h('canvas', { class: 'rig-canvas', 'aria-hidden': 'true' });
  const gpu = createCompositor(canvas);
  const root = h('div', { class: 'rig rig-clips', 'data-live': 'false', ...(m.mirror ? { 'data-mirror': '' } : {}), ...(m.floor ? { 'data-floor': '' } : {}), 'data-speaking': 'false', 'data-thinking': 'false', style: { 'aspect-ratio': `${aw} / ${ah}`, '--rig-ar': String(aw / ah), ...rootStyle } }, idle, ...overs, canvas, slot);
  let speaking = false;
  let weights = { idle: 1, slots: [0, 0] };
  // Small head moves the director asks for (a nod, a tilt). They sit on top of the neck track and turn about the same pivot, so the seam stays put.
  const nodSpring = createSpring(0, { stiffness: 90, damping: 19 });
  const tiltSpring = createSpring(0, { stiffness: 36, damping: 12 });
  /** @type {{t:number, fn:()=>void}[]} */
  let timers = [];
  const hasTracks = m.tracked && tracks[m.idle];
  // The head turns about the neck: the bottom of the seam, in the middle of the head area.
  slot.style.setProperty('--pivot-y', `${((pivot - m.head.top) / m.head.height) * 100}%`);
  const idleReady = () => !idle.paused && idle.readyState >= 2 && !idle.seeking;
  const idlePhase = () => ((frameTime(idle) * FPS) % joins.idle + joins.idle) % joins.idle;

  /** Load a gesture into the next slot, paused. It starts once it matches the idle pose. */
  const startJob = ({ clip, rate, frames }) => {
    lastSlot ^= 1;
    const v = overs[lastSlot];
    job = { clip, rate, frames, i: lastSlot, stage: 'load', age: 0, stall: 0, plan: null, exit: null, idleSeeked: false, primed: false, k0: 0 };
    v.pause();
    v.replaceChildren(...sources(clip).map(([file, type]) => h('source', { src: `${base}/${file}`, type })));
    v.load();
    v.playbackRate = rate;
  };
  const drop = () => { if (job) overs[job.i].pause(); job = null; };

  /** Choose the clip frame and the idle frame to join on, and seek the clip to its frame. */
  const arm = () => {
    job.plan = joins && idleReady() ? planEntry(joins, job.clip, idlePhase(), { minAhead: SEEK_LEAD }) : null;
    overs[job.i].currentTime = ((job.plan?.k ?? 0) + 0.5) / FPS;
    job.stage = 'seek';
  };
  /** The idle loop is at the matching pose: show the gesture. The idle loop holds that pose through the fade. */
  const go = () => {
    const mine = job;
    const v = overs[mine.i];
    layers.start(mine.clip, mine.i);
    layers.ready(mine.i, true);
    if (mine.plan) idle.pause();
    v.play().catch(() => { if (job === mine) leave(); });
    root.dataset.gesture = mine.clip;
    mine.stage = 'play';
    const k0 = mine.plan?.k ?? 0;
    mine.k0 = k0;
    mine.exit = joins ? planExit(joins, mine.clip, k0, { minAhead: EXIT_LEAD, target: k0 + mine.frames }) : null;
  };
  /** Hand back to the idle loop, which was seeked to the pose this clip frame matches. */
  const leave = () => {
    if (!job || job.stage !== 'play') return;
    layers.end(job.i);
    idle.play()?.catch?.(() => {});
    root.dataset.gesture = '';
    job.stage = 'leave';
  };
  /** Move the planned exit up to the next good one. */
  const shorten = () => {
    if (!job || job.stage !== 'play') return;
    if (!job.exit) { leave(); return; }
    const next = planExit(joins, job.clip, frameTime(overs[job.i]) * FPS, { minAhead: EXIT_LEAD });
    if (next.k >= job.exit.k) return;
    if (next.p !== job.exit.p) job.idleSeeked = false;
    job.exit = next;
  };

  /** Move the gesture along its stages. */
  const advance = (dtMs) => {
    if (!job) { if (idle.paused && !idle.seeking) startIdle(); return; }
    const mine = job;
    const v = overs[mine.i];
    mine.age += dtMs;
    if (mine.stage !== 'play' && mine.stage !== 'leave' && (mine.age > 12000 || v.error)) { drop(); return; }
    if (mine.stage === 'load') {
      if (v.readyState >= 2) arm();
      else if (mine.age > 1500 && !mine.primed) {
        // Some browsers load nothing for a paused video. Playing it for a moment gets the first frame.
        mine.primed = true;
        v.play().then(() => { if (job !== mine || mine.stage === 'load' || mine.stage === 'seek' || mine.stage === 'armed') v.pause(); }).catch(() => {});
      }
    } else if (mine.stage === 'seek') {
      if (!v.seeking && v.readyState >= 2) mine.stage = 'armed';
    } else if (mine.stage === 'armed') {
      const wait = mine.plan ? ahead(idlePhase(), mine.plan.p, joins.idle) : 0;
      if (mine.plan && (!idleReady() || wait < -1.5 || wait > 48)) arm(); // missed it, or the idle loop looped: plan again
      else if (wait <= 0.6) go();
    } else if (mine.stage === 'play') {
      mine.stall = v.readyState < 2 ? mine.stall + dtMs : 0;
      if (mine.stall > 1500) { leave(); return; }
      const e = mine.exit;
      if (!e) return;
      const k = frameTime(v) * FPS;
      // Ease the speed: slow where the hand lifts and settles, full in the middle. Constant speed reads as mechanical.
      const u = Math.max(0, Math.min(1, (k - mine.k0) / Math.max(1, e.k - mine.k0)));
      const want = mine.rate * (0.72 + 0.28 * Math.sin(Math.PI * u));
      if (Math.abs(v.playbackRate - want) > 0.02) v.playbackRate = want;
      if (!mine.idleSeeked && k >= e.k - EXIT_LEAD) { idle.pause(); idle.currentTime = (e.p + 0.5) / FPS; mine.idleSeeked = true; }
      if (mine.idleSeeked && k >= e.k - 0.5 && !idle.seeking && idle.readyState >= 2) leave();
    } else if (weights.slots[mine.i] === 0) {
      v.pause();
      job = null;
      if (queued) { const next = queued; queued = null; startJob(next); }
    }
  };
  /** Ease the gesture videos in and out. A gesture fades in once it has a frame. @param {number} dtMs */
  const blend = (dtMs) => {
    advance(dtMs);
    const cur = layers.current;
    if (cur >= 0) layers.ready(cur, overs[cur].readyState >= 2);
    weights = layers.step(dtMs);
    // A faded-out gesture stops decoding.
    overs.forEach((v, i) => { if (i !== layers.current && weights.slots[i] === 0 && !v.paused && !(job && job.i === i && job.stage === 'load')) v.pause(); });
  };
  /** Draw the clips at the canvas's on-screen size (sharp on dense screens, capped at 2x). */
  const paint = () => {
    const w = Math.min(Math.round(root.clientWidth * Math.min(globalThis.devicePixelRatio || 1, 2)), 1440);
    if (!w) return;
    gpu.resize(w, Math.round((w * ah) / aw));
    // The bodies sway out of step. Fading the idle one out as a gesture comes in keeps a ghost of it from showing at the edges.
    gpu.draw([{ video: idle, alpha: weights.idle, time: frameTime(idle) }, ...overs.map((video, i) => ({ video, alpha: weights.slots[i], time: frameTime(video) }))]);
  };
  /** Put the live head on the neck: the fit, plus the neck's motion when the body has tracks. */
  const follow = () => {
    let [x, y, r] = [0, 0, 0];
    if (hasTracks) {
      // The neck moves with whichever videos are showing, in the same proportion.
      const idleAt = sampleTrack(tracks[m.idle], frameTime(idle));
      [x, y, r] = idleAt.map((v) => v * weights.idle);
      overs.forEach((video, i) => {
        const w = weights.slots[i];
        const t = w > 0 ? tracks[layers.clip(i)] : null;
        const at = t ? sampleTrack(t, frameTime(video)) : idleAt;
        x += at[0] * w; y += at[1] * w; r += at[2] * w;
      });
    }
    const w = root.clientWidth;
    const side = m.mirror ? -1 : 1; // the figure is flipped, so the neck's sideways motion and tilt flip with it
    x *= side; r *= side;
    y += nodSpring.value * 0.0024; // fraction of the frame width
    r += tiltSpring.value * 0.02; // radians, about the neck
    slot.style.setProperty('--hx', `${((x + side * m.fit.dx) * w).toFixed(2)}px`);
    slot.style.setProperty('--hy', `${((y + m.fit.dy) * w).toFixed(2)}px`);
    slot.style.setProperty('--hr', `${r.toFixed(5)}rad`);
  };

  /**
   * Cut the head out of its backdrop and fade it over the seam. The live video (or the still, before a session) is drawn
   * into a canvas, then the matte and the seam gradient are applied. One cheap 2D draw, only when the frame changed.
   * A CSS mask would do the same, but Firefox redraws it every frame and drops to 30 fps.
   */
  const head = () => {
    if (!hctx || !matte?.complete || !matte.naturalWidth) return;
    const live = slot.querySelector('video');
    const useLive = root.dataset.live === 'true' && live && live.readyState >= 2 && live.videoWidth;
    // A live video that stalls for a moment (a network hiccup) keeps its last frame. Going back to the still would flash a different face.
    if (liveShown && root.dataset.live === 'true' && !useLive) return;
    if (useLive) liveShown = true;
    const src = useLive ? live : slot.querySelector('.rig-still');
    const [sw, sh] = useLive ? [live.videoWidth, live.videoHeight] : [src?.naturalWidth, src?.naturalHeight];
    if (!sw) return;
    const cw = Math.min(Math.round(slot.clientWidth * Math.min(globalThis.devicePixelRatio || 1, 2) * m.fit.scale), 768);
    if (!cw) return;
    const key = `${useLive ? 'v' : 's'}${useLive ? live.currentTime : 0}:${cw}`;
    if (key === drawn) return;
    drawn = key;
    const ch = Math.round((cw * slot.clientHeight) / slot.clientWidth);
    if (headCanvas.width !== cw || headCanvas.height !== ch) { headCanvas.width = cw; headCanvas.height = ch; }
    const k = Math.max(cw / sw, ch / sh); // object-fit: cover
    hctx.globalCompositeOperation = 'source-over';
    hctx.clearRect(0, 0, cw, ch);
    hctx.drawImage(src, (sw - cw / k) / 2, (sh - ch / k) / 2, cw / k, ch / k, 0, 0, cw, ch);
    hctx.globalCompositeOperation = 'destination-in';
    hctx.drawImage(matte, 0, 0, cw, ch);
    const fade = hctx.createLinearGradient(0, seam[0] * ch, 0, seam[1] * ch);
    fade.addColorStop(0, '#000');
    fade.addColorStop(0.5, '#0000'); // gone by mid-band: both necklines are never half visible at once
    hctx.fillStyle = fade;
    hctx.fillRect(0, 0, cw, ch);
  };

  const startIdle = () => { idle.play?.()?.catch?.(() => {}); };
  idle.addEventListener('canplay', startIdle, { once: true });
  overs.forEach((video, i) => video.addEventListener('ended', () => { if (job?.i === i) leave(); }));

  const body = {
    el: root,
    videoSlot: slot,
    /** Per-frame work: mix the videos, move the head with the neck, draw. @param {number} dtMs */
    tick(dtMs) {
      blend(dtMs);
      timers = timers.filter((t) => { t.t -= dtMs; if (t.t > 0) return true; t.fn(); return false; });
      nodSpring.step(dtMs / 1000);
      tiltSpring.step(dtMs / 1000);
      follow();
      paint();
      head();
    },
    /**
     * Play a gesture clip over the idle loop. It starts when the idle loop reaches a pose that looks like one of its first frames,
     * and hands back at a frame that looks like an idle pose, so the join does not show. That can take up to about a second.
     * A gesture already playing runs on to its next exit first.
     * @param {string} name @param {'right'|'up'|'down'} [dir]
     * @param {{rate?:number, length?:number}} [opts] `rate` speeds the clip up or down (1 = as filmed). `length` is the wanted playing time in seconds
     * @returns {boolean} false when the body has no such clip or motion is reduced
     */
    perform(name, dir = 'right', { rate = 1, length } = {}) {
      if (reduced) return false;
      const clip = clipFor(m.clips, name, dir);
      if (!clip) return false;
      const req = { clip, rate, frames: length > 0 ? length * FPS : GESTURE_FRAMES };
      if (!job) startJob(req);
      else if (job.stage === 'play') { queued = req; shorten(); } else if (job.stage === 'leave') queued = req;
      else { drop(); startJob(req); }
      return true;
    },
    /** Hand back to the idle loop at the next good frame. A gesture that has not started is dropped. */
    release() {
      if (!job) return;
      if (job.stage === 'play') shorten();
      else if (job.stage !== 'leave') drop();
    },
    /** True while a gesture is loading, playing or handing back. */
    get busy() { return job !== null; },
    /** A small head move on top of the neck track: 'nod' (a short dip), 'tilt' (hold to one side, `side` is -1 or 1), 'level' (back to straight). @param {'nod'|'tilt'|'level'} name @param {number} [amount] 0..1 @param {-1|1} [side] */
    cue(name, amount = 1, side = 1) {
      if (reduced) return;
      if (name === 'nod') { nodSpring.target = amount; timers.push({ t: 260, fn: () => { nodSpring.target = 0; } }); }
      else if (name === 'tilt') tiltSpring.target = amount * side;
      else tiltSpring.target = 0;
    },
    /** Change how fast the idle loop plays (about 0.9 to 1.1), so its rhythm does not repeat on a fixed beat. @param {number} rate */
    drift(rate) { idle.playbackRate = Math.max(0.5, Math.min(2, rate)); },
    setSpeaking(on) { speaking = on; root.dataset.speaking = String(on); },
    setThinking(on) { root.dataset.thinking = String(on); },
    setListening() {},
    setLive(on) {
      if (!on) { root.dataset.live = 'false'; liveShown = false; return; }
      // Swap the still for the video only once it has a frame, so the head never blinks out.
      const v = slot.querySelector('video');
      if (!v || (v.readyState >= 2 && v.videoWidth)) root.dataset.live = 'true';
      else v.addEventListener('loadeddata', () => { root.dataset.live = 'true'; }, { once: true });
    },
    get speaking() { return speaking; },
    destroy() { idle.pause(); overs.forEach((v) => v.pause()); gpu.destroy(); root.remove(); },
  };
  return body;
}

/**
 * Fetch a body folder's manifest and build the body.
 * @param {string} base folder URL, no trailing slash
 * @param {{reduced?:boolean}} [opts]
 */
export async function loadClipBody(base, opts = {}) {
  const res = await fetch(`${base}/manifest.json`);
  if (!res.ok) throw new Error(`No body at ${base} (manifest.json: ${res.status}).`);
  const manifest = await res.json();
  const tracks = {};
  if (manifest.tracked === true) {
    // A missing or broken track only means the head stays still. The body still plays.
    const names = [...new Set([manifest.idle, ...Object.values(manifest.clips || {})])];
    await Promise.all(names.map(async (name) => {
      try { const r = await fetch(`${base}/${name}.track.json`); const t = r.ok ? parseTrack(await r.json()) : null; if (t) tracks[name] = t; } catch { /* no track for this clip */ }
    }));
  }
  let joins = null;
  if (typeof manifest.joins === 'string') {
    // Without joins the gestures still play, they just cross-fade instead of joining on matching poses.
    try { const r = await fetch(`${base}/${manifest.joins}`); joins = r.ok ? await r.json() : null; } catch { /* no joins */ }
  }
  return createClipBody({ base, manifest, tracks, joins, ...opts });
}

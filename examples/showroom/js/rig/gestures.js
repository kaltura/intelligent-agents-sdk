/**
 * Gestures as data. A gesture is a list of keyframes; each sets a partial pose
 * at a time. The sequencer is driven by `tick(dtMs)`, so it is deterministic
 * and testable without a clock.
 *
 * Joint names: `lA`/`rA` shoulder angle of the screen-left / screen-right arm
 * (0 = hanging, 90 = straight out, 180 = straight up). `lE`/`rE` elbow bend in
 * degrees. `tilt` head roll, `nod` head pitch offset in px, `lean` torso lean.
 */

/** @typedef {{lA:number,lE:number,rA:number,rE:number,tilt:number,nod:number,lean:number}} Pose */
/** @type {Pose} */
export const REST = { lA: 7, lE: 10, rA: 7, rE: 10, tilt: 0, nod: 0, lean: 0 };

/** @typedef {'right'|'up'|'down'} Direction */
/** @typedef {{at:number,pose:Partial<Pose>}} Keyframe */
/** @typedef {{name:string,keys:Keyframe[]}} Gesture */

/**
 * @param {string} name
 * @param {Direction} [dir] Where the panel is, relative to the robot.
 * @returns {Gesture|null}
 */
export function gesture(name, dir = 'right') {
  switch (name) {
    case 'wave': return { name, keys: [
      { at: 0, pose: { rA: 150, rE: 25, tilt: -4 } },
      { at: 300, pose: { rE: -25 } }, { at: 600, pose: { rE: 30 } }, { at: 900, pose: { rE: -25 } },
      { at: 1200, pose: { rE: 30 } }, { at: 1700, pose: { ...REST } },
    ] };
    case 'present': {
      const to = dir === 'up' ? { rA: 150, rE: 18, lA: 150, lE: 18 } : dir === 'down' ? { rA: 40, rE: 55 } : { rA: 62, rE: 38 };
      return { name, keys: [{ at: 0, pose: { ...to, tilt: dir === 'right' ? 4 : 0, lean: dir === 'right' ? 2 : 0 } }, { at: 1500, pose: { ...REST } }] };
    }
    case 'beat': return { name, keys: [
      { at: 0, pose: { rA: 38, rE: 62, nod: 3 } }, { at: 260, pose: { rA: 30, rE: 50, nod: -1 } }, { at: 900, pose: { ...REST } },
    ] };
    case 'beat2': return { name, keys: [
      { at: 0, pose: { lA: 34, lE: 58, rA: 34, rE: 58, nod: 3 } }, { at: 280, pose: { lA: 28, lE: 48, rA: 28, rE: 48, nod: -1 } }, { at: 950, pose: { ...REST } },
    ] };
    case 'think': return { name, keys: [
      { at: 0, pose: { rA: 75, rE: 125, tilt: 7, lean: 1 } }, { at: 2600, pose: { ...REST } },
    ] };
    case 'celebrate': return { name, keys: [
      { at: 0, pose: { lA: 160, lE: 15, rA: 160, rE: 15, nod: -3 } }, { at: 350, pose: { lE: 40, rE: 40 } }, { at: 700, pose: { lE: 10, rE: 10 } },
      { at: 1050, pose: { lE: 40, rE: 40 } }, { at: 1900, pose: { ...REST } },
    ] };
    case 'shrug': return { name, keys: [
      { at: 0, pose: { lA: 42, lE: 70, rA: 42, rE: 70, tilt: 5, nod: -2 } }, { at: 1300, pose: { ...REST } },
    ] };
    case 'nod': return { name, keys: [{ at: 0, pose: { nod: 5 } }, { at: 200, pose: { nod: -2 } }, { at: 400, pose: { nod: 4 } }, { at: 700, pose: { nod: 0 } }] };
    default: return null;
  }
}

/** Gestures that use only the head, so they can layer over an arm gesture. */
export const HEAD_ONLY = new Set(['nod']);

/**
 * Plays one gesture at a time. Keyframes call `apply(partialPose)` when due.
 * Starting a new gesture replaces the running one, except a head-only gesture
 * which runs beside it.
 * @param {(pose:Partial<Pose>)=>void} apply
 */
export function createSequencer(apply) {
  /** @type {{g:Gesture,t:number,i:number}[]} */
  let lanes = [];
  return {
    /** @param {Gesture|null} g */
    play(g) {
      if (!g) return;
      const lane = { g, t: 0, i: 0 };
      lanes = HEAD_ONLY.has(g.name) ? [...lanes.filter((l) => !HEAD_ONLY.has(l.g.name)), lane] : [lane, ...lanes.filter((l) => HEAD_ONLY.has(l.g.name))];
      this.tick(0);
    },
    /** True while any gesture is still running. */
    get busy() { return lanes.length > 0; },
    get armBusy() { return lanes.some((l) => !HEAD_ONLY.has(l.g.name)); },
    /** @param {number} dtMs */
    tick(dtMs) {
      for (const l of lanes) {
        l.t += dtMs;
        while (l.i < l.g.keys.length && l.g.keys[l.i].at <= l.t) apply(l.g.keys[l.i++].pose);
      }
      lanes = lanes.filter((l) => l.i < l.g.keys.length);
    },
    cancel() { lanes = []; },
  };
}

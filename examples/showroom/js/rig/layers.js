/**
 * Mixing weights for the gesture videos. Pure, no DOM, so it runs under tests.
 *
 * Two gesture slots take turns. A new gesture loads into the slot that is not showing, and the shown one
 * keeps its last frame on screen until the new one has a frame. Then the two cross-fade at the same speed,
 * so their weights plus the idle loop's always add up to 1 and the figure never jumps to the idle pose.
 */

/** @param {{fadeMs?:number}} [opts] */
export function createLayers({ fadeMs = 200 } = {}) {
  const slots = [{ clip: '', w: 0, ready: false }, { clip: '', w: 0, ready: false }];
  let current = -1; // the slot whose clip should be showing
  let previous = -1; // the slot kept on screen until `current` has a frame
  return {
    /**
     * Begin a clip. Returns the slot to load it into, or `into` when the caller has loaded it already.
     * @param {string} clip
     * @param {number} [into]
     */
    start(clip, into) {
      let i;
      if (into !== undefined) {
        const shown = current >= 0 ? current : -1;
        i = into;
        previous = shown >= 0 && shown !== i && slots[shown].w > 0 ? shown : -1;
      } else if (current >= 0 && !slots[current].ready) {
        i = current; // still loading: swap what loads, keep what is on screen
      } else {
        const shown = current >= 0 ? current : (slots[0].w >= slots[1].w ? 0 : 1);
        i = shown === 0 ? 1 : 0;
        previous = slots[shown].w > 0 || shown === current ? shown : -1;
      }
      slots[i].clip = clip;
      slots[i].ready = false;
      current = i;
      return i;
    },
    /** The slot's video has (or lost) a frame. @param {number} i @param {boolean} on */
    ready(i, on) { slots[i].ready = on; },
    /** The slot's clip is over: fade it out. @param {number} i */
    end(i) {
      if (i !== current) return;
      current = -1;
      previous = -1;
      slots[i].ready = false;
    },
    /** Fade out whatever is playing. */
    release() { if (current >= 0) this.end(current); },
    /** The clip name a slot holds, or ''. @param {number} i */
    clip(i) { return slots[i].clip; },
    /** The slot that is playing, or -1. */
    get current() { return current; },
    /** True while a gesture is playing or loading. */
    get busy() { return current >= 0; },
    /**
     * Move the weights toward their targets.
     * @param {number} dtMs
     * @returns {{idle:number, slots:number[]}} weights that sum to 1
     */
    step(dtMs) {
      const stepBy = dtMs / fadeMs;
      const currentReady = current >= 0 && slots[current].ready;
      slots.forEach((s, i) => {
        const want = i === current ? (s.ready ? 1 : 0) : (i === previous && !currentReady ? 1 : 0);
        s.w += Math.sign(want - s.w) * Math.min(Math.abs(want - s.w), stepBy);
      });
      if (currentReady) previous = -1;
      const sum = slots[0].w + slots[1].w;
      const k = sum > 1 ? 1 / sum : 1;
      return { idle: Math.max(0, 1 - sum * k), slots: slots.map((s) => s.w * k) };
    },
  };
}

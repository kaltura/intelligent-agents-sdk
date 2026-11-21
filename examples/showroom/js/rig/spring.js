/**
 * A damped spring with a fixed-step integrator, so motion looks the same at
 * 30, 60 or 144 fps. State lives in the closure.
 * @param {number} [initial]
 * @param {{stiffness?:number,damping?:number}} [opts]
 */
export function createSpring(initial = 0, { stiffness = 120, damping = 14 } = {}) {
  let value = initial;
  let velocity = 0;
  let target = initial;
  const STEP = 1 / 120;
  return {
    get value() { return value; },
    get target() { return target; },
    /** @param {number} t */
    set target(t) { target = t; },
    /** Jump with no motion. @param {number} v */
    snap(v) { value = v; target = v; velocity = 0; },
    /** True once the spring has effectively stopped. */
    get settled() { return Math.abs(target - value) < 0.01 && Math.abs(velocity) < 0.01; },
    /**
     * Advance by `dtSeconds` (capped so a background tab does not explode it).
     * @param {number} dtSeconds
     */
    step(dtSeconds) {
      let left = Math.min(dtSeconds, 0.1);
      while (left > 1e-9) {
        const dt = Math.min(STEP, left);
        velocity += (-stiffness * (value - target) - damping * velocity) * dt;
        value += velocity * dt;
        left -= dt;
      }
      return value;
    },
  };
}

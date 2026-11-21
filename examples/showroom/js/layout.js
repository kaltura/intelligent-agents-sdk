/**
 * Layout choice from the viewport. Pure: the same input always gives the same
 * answer, so every size can be unit-tested without a browser.
 *
 * | layout | when | arrangement |
 * |---|---|---|
 * | `wide`  | landscape or near-square | robot left, panel right |
 * | `tall`  | portrait, 600 px or wider (tablet, kiosk) | tablet: panel on top, robot below. Tall kiosk (aspect under 0.62): robot left, panel right |
 * | `phone` | portrait, under 600 px | small robot on top, panel below |
 */

/** @typedef {'wide'|'tall'|'phone'} Layout */

/** Design size per layout. `base` is the body font size in design pixels. */
export const DESIGN = {
  wide: { w: 1920, h: 1080, base: 24 },
  tall: { w: 1080, h: 1920, base: 21 },
  phone: { w: 430, h: 932, base: 16 },
};

/**
 * @param {{width:number,height:number}} viewport
 * @returns {Layout}
 */
export function pickLayout({ width, height }) {
  if (width / height >= 0.95) return 'wide';
  return width >= 600 ? 'tall' : 'phone';
}

/**
 * Size of one design pixel, so everything scales with the screen.
 * Never below a readable floor.
 * @param {Layout} layout
 * @param {{width:number,height:number}} viewport
 * @returns {{unit:number,fontPx:number}}
 */
export function unitFor(layout, { width, height }) {
  const d = DESIGN[layout];
  const unit = Math.min(width / d.w, height / d.h);
  const fontPx = Math.max(14, Math.round(d.base * unit * 10) / 10);
  return { unit, fontPx };
}

/**
 * Which side the robot presents to, so gestures point at the panel.
 * @param {Layout} layout
 * @returns {'right'|'up'|'down'}
 */
export const presentDirection = (layout) => (layout === 'wide' ? 'right' : layout === 'tall' ? 'up' : 'down');

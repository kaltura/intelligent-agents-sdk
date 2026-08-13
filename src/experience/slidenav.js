/**
 * Slide-number word parser — turns a spoken slide reference ("24", "twenty-four",
 * "number 24") into a bounded integer. Extracted from the earnings reference app
 * (the avatar narrates "navigating to slide twenty-four" and the app must resolve
 * it to a page). Pure, dependency-free, exhaustively unit-tested.
 */
const WORD_TO_NUM = (() => {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const m = {};
  ones.forEach((w, i) => { m[w] = i; });
  for (const [w, v] of Object.entries(tens)) {
    m[w] = v;
    for (let i = 1; i < 10; i++) { m[w + '-' + ones[i]] = v + i; m[w + ' ' + ones[i]] = v + i; m[w + ones[i]] = v + i; }
  }
  return m;
})();

/**
 * Parse a slide reference into a 1..max integer, or null if it isn't one.
 * @param {string|number} raw   e.g. "24", "twenty-four", "number 24", "slide 7".
 * @param {number} [max=Infinity]  Upper bound (e.g. total slides); out-of-range → null.
 * @returns {number|null}
 */
export function parseSlideNumber(raw, max = Infinity) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/^(?:number|slide|page)\s+/, '');
  if (/^\d+$/.test(s)) { const n = +s; return n >= 1 && n <= max ? n : null; }
  if (WORD_TO_NUM[s] != null) { const n = WORD_TO_NUM[s]; return n >= 1 && n <= max ? n : null; }
  return null;
}

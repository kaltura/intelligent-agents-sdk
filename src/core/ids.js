/**
 * Client-side identifier + provenance helpers. These are things the SDK can do
 * TODAY without any server change (the directive's "achievable client-side"
 * bar): generate idempotency keys, stamp provenance receipts, mint the random
 * room/sticky ids the live runtime needs.
 *
 * Uses Web Crypto (`globalThis.crypto`), present in Node ≥18 and every browser
 * — no `node:crypto` import, so the same file runs in both. Falls back to a
 * non-crypto generator only if Web Crypto is absent (never throws).
 */

const HEX = '0123456789abcdef';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** @param {number} n @returns {Uint8Array} */
function randomBytes(n) {
  const c = globalThis.crypto;
  const out = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256); // last-resort, non-crypto
  return out;
}

/** RFC 4122 v4 UUID. Used as the default Idempotency-Key on creates. */
export function uuidv4() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => HEX[x >> 4] + HEX[x & 15]);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/**
 * Lowercase alphanumeric id of length `n` (matches the runtime's room/sticky id
 * shape — app.js `randId`). 16 chars for stickyId, 12 for roomId.
 * @param {number} [n]
 */
export function randId(n = 16) {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[b[i] % ALNUM.length];
  return s;
}

/**
 * A provenance/freshness receipt for any parsed or aggregated result (CLAUDE.md
 * → "Output schemas carry provenance/freshness"). `generatedAt` is stamped from
 * the caller's clock so the result is self-describing for audit.
 * @param {{partnerId?:string|number, source:string, scope:string, [k:string]:unknown}} fields
 */
export function meta(fields) {
  return {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...fields,
  };
}

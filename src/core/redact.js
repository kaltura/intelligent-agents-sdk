/**
 * Secret redaction — the single chokepoint every log line, error, and emitted
 * record passes through. Kaltura KS tokens (`djJ8…`), bare hex secrets, and
 * RFC1918 private IPs must NEVER leave the process in cleartext (CLAUDE.md →
 * "No secrets, ever."; check-docs.sh scans for exactly these patterns).
 *
 * This is mechanical, not best-effort: the SDK routes 100% of its diagnostic
 * output through {@link redact}, so a token can't leak through a stray
 * console.log or a thrown error message.
 *
 * Three layers: (1) string-pattern scrub (KS / 32-hex / private-IP); (2)
 * sensitive-key wholesale redaction (`secret`/`password`/`credential`/`token`/
 * `ks`); (3) a STRUCTURAL `request_vars` rule — converse client variables hold
 * arbitrary PII scalars under arbitrary keys that match no pattern, so the
 * whole sub-tree is replaced by key-name.
 */

import { PRIVATE_IP_RE } from './net-guard.js';

/** KSv2 tokens are base64url starting with the literal `djJ8` ("v2|" encoded). */
const KS_RE = /djJ8[A-Za-z0-9_\-+/=]{16,}/g;
/** A bare Kaltura admin secret is 32 lowercase hex chars. */
const HEX32_RE = /\b[a-f0-9]{32}\b/g;

/**
 * Redact secrets from any value. Strings are scrubbed in place; objects/arrays
 * are deep-cloned with every string leaf scrubbed. Non-JSON values are returned
 * untouched. Never throws.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return /** @type {T} */ (value.map(redact));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // STRUCTURAL rule: `request_vars` carries arbitrary
      // caller-supplied client variables — PII scalars under arbitrary keys
      // (`firstName`, `email`) that match NEITHER a sensitive-key regex NOR a
      // secret value pattern. Replace the WHOLE sub-tree by key-name match,
      // wherever it appears in a serialized object (converse body, audit log,
      // getResults()). This is the only safe rule for opaque PII values.
      if (k === 'request_vars') {
        out[k] = '<request_vars-redacted>';
        continue;
      }
      // Redact whole values of obviously-sensitive keys regardless of shape.
      out[k] = /secret|password|credential|token|\bks\b/i.test(k)
        ? redactSensitiveKey(v)
        : redact(v);
    }
    return /** @type {T} */ (out);
  }
  return value;
}

/** @param {string} s */
export function redactString(s) {
  return s
    .replace(KS_RE, '<KS>')
    .replace(PRIVATE_IP_RE, '<private-ip>')
    .replace(HEX32_RE, '<secret>');
}

/** @param {unknown} v */
function redactSensitiveKey(v) {
  if (typeof v === 'string') return v ? '<redacted>' : v;
  return redact(v);
}

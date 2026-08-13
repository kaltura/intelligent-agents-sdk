/**
 * Canonical private-network / SSRF host detector — the single source of truth
 * for "is this target a private, loopback, or link-local network address."
 * Lives in core/ so both management/ and experience/ can import it without a
 * layering violation (core/ has no dependency on either).
 *
 * Consolidates FOUR previously independent hand-rolled regexes that had each
 * drifted to cover a different subset of the same threat:
 * - {@link isPrivateOrLoopbackHost} — the general-purpose predicate, used by
 *   `experience/wire.js` (WHEP-URL private-IP rejection) and
 *   `experience/session.js` (local-host detection for the insecure-transport
 *   warning).
 * - {@link PRIVATE_IP_RE} — the free-text scrubbing regex consumed by
 *   `core/redact.js` to keep these addresses out of logs/audit output.
 */

// IPv4 range fragments (shared by the free-text scrub and the anchored host check):
//   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918 private),
//   127.0.0.0/8 (loopback — the WHOLE block, not just 127.0.0.1),
//   169.254.0.0/16 (link-local, which includes the 169.254.169.254 cloud-metadata
//   SSRF target on AWS/GCP/Azure).
const IPV4_PRIVATE_SOURCE =
  '(?:10(?:\\.\\d{1,3}){3}' +
  '|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}' +
  '|192\\.168(?:\\.\\d{1,3}){2}' +
  '|127(?:\\.\\d{1,3}){3}' +
  '|169\\.254(?:\\.\\d{1,3}){2})';

/**
 * Non-anchored, global — matches any occurrence of a private/loopback/link-local
 * IPv4 literal inside free text (log/audit scrubbing). Deliberately does NOT match
 * the words `localhost` or the IPv6 literal `::1` — those are hostnames, not IP
 * octet sequences, and word-scrubbing them out of arbitrary log prose would be
 * noisy/over-eager. Use {@link isPrivateOrLoopbackHost} for a single-host/URL check.
 */
export const PRIVATE_IP_RE = new RegExp(`\\b${IPV4_PRIVATE_SOURCE}\\b`, 'g');

// Anchored (whole-string) form of the same IPv4 ranges, for a single extracted host.
const IPV4_PRIVATE_HOST_RE = new RegExp(`^${IPV4_PRIVATE_SOURCE}$`);

/**
 * True if `hostOrUrl` is a private RFC1918 address (10/8, 172.16/12, 192.168/16),
 * an IPv4 loopback address (127.0.0.0/8 — the whole block, not just 127.0.0.1), an
 * IPv4 link-local address (169.254.0.0/16 — includes the 169.254.169.254
 * cloud-metadata SSRF target), the literal hostname `localhost`, or the IPv6
 * loopback `::1` (bracketed `[::1]` or bare `::1`). This is the syntactic
 * SSRF/private-network check every outbound URL built from caller/attacker input
 * should pass BEFORE the network call is made.
 *
 * Accepts a bare hostname, a bare IP literal, or a full URL string.
 *
 * NOT covered (out of scope for this predicate): IPv6 unique-local (fc00::/7),
 * IPv6 link-local (fe80::/10), DNS rebinding (a public-looking name that
 * resolves to a private IP at connect time), or any resolver-level check — this
 * is purely a syntactic string/hostname test, run before DNS resolution.
 * @param {string} hostOrUrl
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(hostOrUrl) {
  const host = extractHost(hostOrUrl);
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return IPV4_PRIVATE_HOST_RE.test(host);
}

/**
 * Best-effort hostname extraction: try as an absolute URL, then as a bare
 * `host[:port]`, falling back to the trimmed/lowercased input verbatim (so an
 * already-bare hostname or IP literal still matches). Never throws.
 * @param {string} hostOrUrl @returns {string}
 */
function extractHost(hostOrUrl) {
  const s = String(hostOrUrl == null ? '' : hostOrUrl).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.hostname) return u.hostname.toLowerCase();
  } catch { /* not an absolute URL */ }
  try {
    const u = new URL(`http://${s}`);
    if (u.hostname) return u.hostname.toLowerCase();
  } catch { /* not a bare host[:port] either */ }
  return s.toLowerCase();
}

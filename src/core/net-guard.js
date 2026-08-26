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
 *   `core/transport-guard.js` (local-host detection for the insecure-transport
 *   warning).
 * - {@link PRIVATE_IP_RE} — the free-text scrubbing regex consumed by
 *   `core/redact.js` to keep these addresses out of logs/audit output.
 *
 * This module must stay dependency-free: `core/redact.js` (and through it
 * `core/errors.js`) imports from here, so importing errors.js here would
 * close an import cycle. TLS enforcement, which throws a typed KalturaError,
 * lives in `core/transport-guard.js` for that reason.
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

// IPv6 unique-local (fc00::/7 — first hextet fc00-fdff) and link-local
// (fe80::/10 — first hextet fe80-febf) address prefixes, anchored to the start
// of a (bracket-stripped) IPv6 literal.
const IPV6_ULA_OR_LINK_LOCAL_RE = /^(?:(?:fc|fd)[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

/**
 * True if `hostOrUrl` is a private RFC1918 address (10/8, 172.16/12, 192.168/16),
 * an IPv4 loopback address (127.0.0.0/8 — the whole block, not just 127.0.0.1), an
 * IPv4 link-local address (169.254.0.0/16 — includes the 169.254.169.254
 * cloud-metadata SSRF target), the literal hostname `localhost`, the IPv6
 * loopback `::1` (bracketed `[::1]` or bare `::1`), an IPv6 unique-local address
 * (fc00::/7), an IPv6 link-local address (fe80::/10), or an IPv4-mapped IPv6
 * address (`::ffff:a.b.c.d` / `::ffff:HHHH:HHHH`) whose embedded IPv4 falls in
 * any of the above IPv4 ranges. This is the syntactic SSRF/private-network
 * check every outbound URL built from caller/attacker input should pass
 * BEFORE the network call is made.
 *
 * Accepts a bare hostname, a bare IP literal, or a full URL string.
 *
 * NOT covered (out of scope for this predicate, by design): DNS rebinding —
 * a public-looking hostname that can resolve to a private/metadata IP only at
 * connect time. This is a pre-resolution string check, so it cannot see what
 * a name resolves to; closing that gap requires a resolve-then-check at the
 * point of connection (e.g. a custom DNS lookup that validates the resolved
 * address before the socket is opened), not a string check. Tracked as a
 * known limitation; see the repository's private security advisories for
 * specifics rather than documenting bypass techniques in source comments.
 * @param {string} hostOrUrl
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(hostOrUrl) {
  const host = extractHost(hostOrUrl);
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (IPV4_PRIVATE_HOST_RE.test(host)) return true;

  const bare = stripBrackets(host);
  if (IPV6_ULA_OR_LINK_LOCAL_RE.test(bare)) return true;

  const mappedIPv4 = extractIPv4MappedAddress(bare);
  if (mappedIPv4 && IPV4_PRIVATE_HOST_RE.test(mappedIPv4)) return true;

  return false;
}

/** Strips a single enclosing `[...]` bracket pair, if present. @param {string} host @returns {string} */
function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Extracts the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d` dotted form, or the `::ffff:HHHH:HHHH` hex-hextet form
 * that `URL` normalizes dotted input into, e.g. `::ffff:127.0.0.1` →
 * `::ffff:7f00:1`). Returns null if `host` isn't in either form.
 * @param {string} host (bracket-stripped) @returns {string|null}
 */
function extractIPv4MappedAddress(host) {
  const dotted = host.match(/(?:^|:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1];

  const hex = host.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }

  return null;
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

/**
 * Output-handling safety primitives (OWASP LLM05 "Improper Output Handling").
 *
 * The avatar's brain is an LLM: every server-pushed string (captions, GenUI
 * link/label, nav text) is attacker-influenceable output and MUST be treated as
 * untrusted before it touches the DOM. These helpers make the safe path the easy
 * path — escape text, scheme-check URLs, and build GenUI links via DOM APIs
 * (never `innerHTML`). Zero-dependency and isomorphic (no DOM needed for the
 * string helpers; `renderSafeLink` no-ops outside a browser).
 *
 * They complement (do not replace) {@link redact}: redact() scrubs SECRETS from
 * outbound logs; these scrub UNTRUSTED LLM OUTPUT bound for the DOM.
 */

// ASCII control characters (C0 range + DEL) — stripped from untrusted text.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Plain, length-bounded text from untrusted output — strips ASCII control chars. @param {unknown} s @param {number} [max] */
export function safeText(s, max = 2000) {
  return String(s == null ? '' : s).replace(CONTROL_CHARS, '').slice(0, max);
}

const SAFE_URL_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/**
 * Return `url` only if its scheme is allow-listed (default https/http/mailto/tel);
 * otherwise '' (blocks `javascript:`, `data:`, `vbscript:`, unknown schemes — the
 * classic XSS link vector). A scheme-relative path (`/foo`, `foo/bar`) is allowed, but an
 * authority-relative URL (`//host`, `\\host`) is REJECTED — the browser resolves it to the
 * current protocol + an arbitrary cross-origin host (open-redirect / embed-hijack vector).
 * Also rejects (returns '') any URL carrying embedded userinfo credentials
 * (`https://user:pass@host/...`) — not classic XSS, but a phishing / link-spoofing vector:
 * a `user:pass@` prefix lets an attacker-controlled label point at a credential-dressed
 * hostname that looks trusted. @param {unknown} url @param {{allow?:string[]}} [opts]
 */
export function safeUrl(url, opts = {}) {
  const raw = String(url == null ? '' : url).trim().replace(CONTROL_CHARS, '');
  if (!raw) return '';
  if (/^[/\\]{2}/.test(raw)) return '';   // //evil.com or \\evil.com → cross-origin authority, not a relative path
  const m = /^([a-z][a-z0-9+.\-]*):/i.exec(raw);
  if (!m) return raw;   // no scheme → relative path → allow
  const allow = opts.allow ? new Set(opts.allow.map((s) => (s.endsWith(':') ? s : s + ':').toLowerCase())) : SAFE_URL_SCHEMES;
  if (!allow.has(m[1].toLowerCase() + ':')) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return '';   // embedded credentials → phishing/link-spoofing vector
  } catch { /* not parseable as an absolute URL (e.g. a bare `mailto:`/`tel:` value) → no authority, no userinfo risk */ }
  return raw;
}

/**
 * Build a GenUI link as a real DOM node (createElement + textContent +
 * scheme-checked href) — NEVER `innerHTML`, so an attacker-influenced label/url
 * can't inject markup or a `javascript:` href. Returns the `<a>` (or null
 * outside a browser / if the URL is unsafe). @param {{url?:string,label?:string,target?:string}} info @param {{allow?:string[]}} [opts]
 */
export function renderSafeLink(info, opts = {}) {
  if (typeof document === 'undefined') return null;
  const href = safeUrl(info && info.url, opts);
  if (!href) return null;
  const a = document.createElement('a');
  a.href = href;
  a.textContent = safeText((info && info.label) || href, 200);
  a.target = info && info.target === '_self' ? '_self' : '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * Drop prototype-pollution keys (`__proto__`/`constructor`/`prototype`) from a
 * JSON value, deep, returning a plain-JSON clone. Functions/symbols are dropped.
 * Shared by setDynamicPrompt (outbound) and inbound payload handling (OWASP
 * deserialization / SI-10). @param {any} v @param {number} [depth]
 */
export function sanitizeJson(v, depth = 0) {
  if (depth > 64 || v === null || typeof v !== 'object') return (typeof v === 'function' || typeof v === 'symbol') ? undefined : v;
  if (Array.isArray(v)) return v.map((x) => sanitizeJson(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const s = sanitizeJson(val, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** Clamp untrusted inbound text to a sane max + strip non-printable control chars, but
 * KEEP \t/\n/\r (LLM05 inbound) — every `agent_raw_text`/`brainSegment` string this feeds
 * (GenUI `unisphere-tool` bodies, spoken captions) can be genuinely multi-line, and a
 * downstream line-oriented parser (e.g. genui/parse.js's YAML-ish block parser) depends on
 * those newlines surviving. Stripping them silently collapsed a multi-line GenUI body into
 * one line before it ever reached the parser — see CONTROL_CHARS_SOURCE below, the same
 * carve-out `safeSource` already makes for verbatim content. @param {unknown} s @param {number} [max] */
export function clampInbound(s, max = 8000) {
  if (typeof s !== 'string') return s;
  return s.replace(CONTROL_CHARS_SOURCE, '').slice(0, max);
}

// Non-printable C0 characters EXCEPT \t (0x09), \n (0x0A), \r (0x0D) — used for verbatim source content.
// The range IS inclusive of NUL: \x00-\x08 strips 0x00 (NUL) through 0x08, \x0b/\x0c strip VT/FF,
// \x0e-\x1f strip the rest of C0, and \x7f strips DEL. All are written as \x-escapes (not literal
// bytes) so this source file itself stays free of raw control bytes — that's a source-hygiene choice,
// not a statement about which characters the regex matches at runtime.
const CONTROL_CHARS_SOURCE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Length-bounded text for verbatim source content (code, diagram definitions, LaTeX).
 * Unlike safeText(), this preserves \\n, \\r, and \\t so multi-line source is not collapsed
 * into a single unreadable line. Only strips non-printable C0 chars that are never valid
 * in source content. @param {unknown} s @param {number} [max] @returns {string}
 */
export function safeSource(s, max = 100000) {
  return String(s == null ? '' : s).replace(CONTROL_CHARS_SOURCE, '').slice(0, max);
}

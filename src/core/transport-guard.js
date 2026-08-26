/**
 * TLS enforcement for transport URLs, shared by every experience-layer session
 * class (avatar, chat) so the transport-security posture cannot drift between
 * transports. Lives apart from net-guard.js because this check throws a typed
 * KalturaError, and core/errors.js (via core/redact.js) already depends on
 * net-guard.js — importing errors.js there would close an import cycle.
 */
import { KalturaError } from './errors.js';
import { isPrivateOrLoopbackHost } from './net-guard.js';

/**
 * Enforce TLS on a transport URL (OWASP WSS/TLS; NIST SC-8). https/wss pass.
 * http/ws fail UNLESS allowInsecure (localhost/dev) — then warn loudly, once.
 * An empty URL is left to the caller's connect-time default.
 * @param {string} url @param {string} field @param {boolean} allowInsecure @param {(m:string)=>void} warn
 */
export function assertSecureTransport(url, field, allowInsecure, warn) {
  if (!url) return;
  let u;
  try { u = new URL(url); } catch { return; }   // malformed → leave to downstream
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (secure) return;
  const insecure = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!insecure) return;                          // unknown scheme → don't block
  const isLocal = isPrivateOrLoopbackHost(u.hostname);
  if (allowInsecure || isLocal) {
    warn(`${field} uses an insecure (${u.protocol}) transport${isLocal ? ' on localhost' : ''}. NEVER ship cleartext to production — use https/wss (NIST SC-8).`);
    return;
  }
  throw new KalturaError({
    type: 'https://docs.kaltura.com/agentic/errors/insecure_transport', title: 'insecure transport', code: 'insecure_transport',
    detail: `${field} must use https/wss (got ${u.protocol}//). Tokens and media must not travel in cleartext (OWASP/NIST SC-8). For localhost dev only, pass allowInsecureTransport:true.`,
  });
}

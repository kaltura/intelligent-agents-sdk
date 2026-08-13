/**
 * Local KS inspection — decode a KSv2 token's PLAINTEXT header without a network
 * call. A real KSv2 is `djJ8`-prefixed base64 of `v2|<partnerId>|<ciphertext>`:
 * the `partnerId` is plaintext, but the privileges are AES-encrypted with the
 * partner secret and are NOT client-readable. So this can reliably report the
 * partnerId but CANNOT determine the privilege kind of a real token.
 *
 * Honest contract: `kind`/`disableEntitlement` are only populated when the
 * privileges happen to be readable as plaintext (which real tokens are not).
 * Callers that need a reliable kind should use the SDK's own {@link Token}
 * object (which records the kind it was minted with), not KS introspection.
 */

/**
 * @param {string} ks
 * @returns {{ok:boolean, partnerId?:string, kind?:string, disableEntitlement?:boolean|null, encrypted?:boolean}}
 */
export function inspectKs(ks) {
  if (!ks || typeof ks !== 'string' || !ks.startsWith('djJ8')) return { ok: false };
  let dec;
  try {
    const b64 = ks.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    dec = b64decode(padded);
  } catch { return { ok: false }; }
  const m = /v2\|(\d+)\|/.exec(dec);
  const partnerId = m ? m[1] : undefined;
  // Privileges readable as plaintext? Only true for non-encrypted/test tokens.
  const hasPlaintextPriv = /(disableentitlement|geniegpcid|agentid|setrole|sview)/.test(dec);
  if (!hasPlaintextPriv) {
    // Real, encrypted token — partnerId only; privilege kind is unknowable here.
    return { ok: !!partnerId, partnerId, kind: 'opaque', disableEntitlement: null, encrypted: true };
  }
  const disableEntitlement = /disableentitlement/.test(dec);
  let kind = 'session';
  if (/geniegpcid/.test(dec)) kind = 'conversation';
  else if (/agentid/.test(dec)) kind = 'agent';
  else if (disableEntitlement) kind = 'admin';
  return { ok: true, partnerId, kind, disableEntitlement, encrypted: false };
}

/** Cross-platform base64 decode to a binary-Latin1 string. @param {string} b64 */
function b64decode(b64) {
  if (typeof atob === 'function') return atob(b64);
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('latin1');
  throw new Error('no base64 decoder');
}

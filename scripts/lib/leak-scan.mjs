/**
 * Count secrets and session tokens in text. Counts only, never the values.
 * Secrets are the values of every env var whose name contains ADMIN_SECRET.
 * Tokens are anything that starts like a session token (`djJ8`).
 * @param {string[]} texts Raw text, before any redaction.
 * @param {Record<string, string|undefined>} env
 * @returns {{secretHits:number, ksHits:number, secretsChecked:number}} `secretsChecked` is how many secret values were looked for. 0 means the scan proved nothing.
 */
export function leakCounts(texts, env) {
  const secrets = Object.entries(env).filter(([k, v]) => /ADMIN_SECRET/.test(k) && v && v.length > 8).map(([, v]) => /** @type {string} */ (v));
  let secretHits = 0; let ksHits = 0;
  for (const body of texts) {
    secretHits += secrets.filter((s) => body.includes(s)).length;
    ksHits += (body.match(/djJ8[A-Za-z0-9_=+/-]{8,}/g) || []).length;
  }
  return { secretHits, ksHits, secretsChecked: secrets.length };
}

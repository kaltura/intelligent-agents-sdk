/**
 * Shared classifier + prober for Genie `partner-config/*` write-door gating.
 * `Intellects#brainConfigAvailable` and `Knowledge#linkAvailable`/`#linkCategory`
 * (conversations.js) all probe or react to the SAME partner-config route to
 * answer "is a partner-config write usable on this deployment": a 403 means
 * deployment-gated (see API-REFERENCE.md § Configure the Brain), a 404 means
 * the route isn't deployed at all. One shared classifier so the call sites
 * can't drift on wording.
 */

/**
 * Classify an error thrown by a `partner-config/*` call into a stable
 * `{code, reason}` pair. PURE — no I/O.
 * @param {unknown} e
 * @returns {{code:string, reason:string}}
 */
export function classifyPartnerConfigError(e) {
  const status = /** @type {{status?:number, code?:string, detail?:string, message?:string}} */ (e)?.status;
  const code = status === 403 ? 'forbidden' : status === 404 ? 'not_deployed' : (/** @type {any} */ (e)?.code || 'error');
  const reason = code === 'forbidden'
    ? 'partner-config/update needs a higher privilege than a partner admin KS (deployment-gated)'
    : code === 'not_deployed'
      ? 'partner-config route not on this deployment'
      : String(/** @type {any} */ (e)?.detail || /** @type {any} */ (e)?.message || code);
  return { code, reason };
}

/**
 * Actively probe whether the partner-config route is reachable + authorized
 * for this KS, via a harmless `partner-config/get`. READ — no state change.
 * Never fakes success: `available:true` only states the door OPENS, it does
 * NOT confirm that any specific field round-trips through it.
 * @param {import('./client.js').Ctx} ctx
 * @param {string} ks
 * @param {string} availableReason Caller-specific success message.
 * @returns {Promise<{available:boolean, reason:string, code?:string}>}
 */
export async function probePartnerConfigRoute(ctx, ks, availableReason) {
  try {
    await ctx.genie('partner-config/get', { id: 0 }, ks);
    return { available: true, reason: availableReason };
  } catch (e) {
    const { code, reason } = classifyPartnerConfigError(e);
    return { available: false, code, reason };
  }
}

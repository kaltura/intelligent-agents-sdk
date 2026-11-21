/**
 * Where the page gets its session start-up data (`ks`, socket and media hosts).
 *
 *   config.json present   a static host. The file names the partner and the widget (both public ids, no secret).
 *                         The browser makes the same anonymous widget call a server would.
 *   no config.json        the local server answers `GET /appInit`.
 */

/** Check a config file and return it, or null. @param {any} c @returns {{partnerId:string, widgetId:string}|null} */
export function parseConfig(c) {
  return c && /^\d+$/.test(String(c.partnerId)) && typeof c.widgetId === 'string' && /^[\w-]+$/.test(c.widgetId) ? { partnerId: String(c.partnerId), widgetId: c.widgetId } : null;
}

/**
 * @param {{ fetchFn?: typeof fetch, loadManagement?: () => Promise<any> }} [deps]
 * @returns {Promise<{ks:string, conversationManagerUrl:string, srsBaseUrl:string, turnServerUrl:string}>}
 */
export async function loadInit({ fetchFn = (...a) => fetch(...a), loadManagement = () => import('../../../src/management/index.js') } = {}) {
  const config = await fetchFn('config.json').then((r) => (r.ok ? r.json() : null)).then(parseConfig, () => null);
  if (config) {
    const { Management } = await loadManagement();
    const kaltura = new Management({ partnerId: config.partnerId });
    const token = await kaltura.sessions.createWidgetToken({ widgetId: config.widgetId });
    return kaltura.application.appInit(token.ks);
  }
  const res = await fetchFn('/appInit');
  if (!res.ok) throw new Error('The token server said no. Run the provision script first.');
  return res.json();
}

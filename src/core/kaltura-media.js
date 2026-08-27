/**
 * Kaltura media-URL helpers — pure, no DOM, no network. Turn an `entryId`
 * (+ partnerId) into the canonical CDN thumbnail and player-embed URLs, and
 * normalize a third-party video URL (YouTube/Vimeo) into a safe iframe-embed
 * URL. Used by the `video-gallery` / `external-video` GenUI renderers so a
 * descriptor can carry a REAL, embeddable player — not just a link.
 *
 * Security: `externalEmbedUrl` only ever returns an embed URL for an explicit
 * allow-list of embed hosts (YouTube/Vimeo/Kaltura). Anything else returns ''
 * so the host falls back to a plain link rather than iframing an arbitrary
 * origin. All ids/partnerIds are character-filtered before interpolation.
 * @module
 */

const PARTNER = /^[0-9]+$/;
const ENTRY = /^[a-z0-9_]+$/i;

/** Sub-partner id (`sp`) is `${partnerId}00` in every Kaltura CDN path. @param {string|number} pid */
function sp(pid) { return `${pid}00`; }

/** True for a usable Kaltura entry id + numeric partner id. */
function ok(entryId, partnerId) {
  return ENTRY.test(String(entryId || '')) && PARTNER.test(String(partnerId || ''));
}

/**
 * Canonical CDN thumbnail URL for a Kaltura entry. Optional width keeps it light.
 * @param {string} entryId @param {string|number} partnerId @param {{width?:number}} [opts]
 * @returns {string} '' when ids are missing/invalid.
 */
export function thumbnailUrl(entryId, partnerId, opts = {}) {
  if (!ok(entryId, partnerId)) return '';
  const base = `https://cfvod.kaltura.com/p/${partnerId}/sp/${sp(partnerId)}/thumbnail/entry_id/${entryId}`;
  const w = Number(opts.width);
  return Number.isFinite(w) && w > 0 ? `${base}/width/${Math.round(w)}` : base;
}

/**
 * A Kaltura player IFRAME src for an entry (the `extwidget/preview` embed page,
 * which renders a full, self-contained player — valid as an `<iframe src>`).
 * @param {string} entryId @param {string|number} partnerId @param {{uiConfId?:string|number}} [opts]
 * @returns {string} '' when ids are missing/invalid.
 */
export function playerEmbedUrl(entryId, partnerId, opts = {}) {
  if (!ok(entryId, partnerId)) return '';
  const ui = String(opts.uiConfId || '').replace(/[^0-9]/g, '');
  const tail = ui ? `/uiconf_id/${ui}` : '';
  return `https://www.kaltura.com/index.php/extwidget/preview/partner_id/${partnerId}${tail}/entry_id/${entryId}/embed/iframe`;
}

/**
 * Normalize a third-party video URL into a safe iframe-embed URL, for an
 * explicit allow-list ONLY (YouTube, Vimeo). Returns `{embedUrl, provider}` —
 * `embedUrl:''` means "not embeddable, fall back to a link".
 * @param {string} url
 * @returns {{embedUrl:string, provider:string}}
 */
export function externalEmbedUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { embedUrl: '', provider: '' };
  /** @type {URL} */
  let parsed;
  try { parsed = new URL(u); } catch { return { embedUrl: '', provider: '' }; }
  const host = parsed.hostname.toLowerCase();
  const isId = (id) => /^[A-Za-z0-9_-]{6,}$/.test(id);

  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/')[1] || '';
    if (isId(id)) return { embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, provider: 'YouTube' };
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    // watch?v=ID | /embed/ID | /shorts/ID | /v/ID — host is exact-matched above
    // (not a substring check), so a lookalike host can't spoof this branch.
    let id = parsed.pathname === '/watch' ? (parsed.searchParams.get('v') || '') : '';
    if (!id) {
      const seg = parsed.pathname.split('/');
      if (['embed', 'shorts', 'v'].includes(seg[1])) id = seg[2] || '';
    }
    if (isId(id)) return { embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, provider: 'YouTube' };
  } else if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const seg = parsed.pathname.split('/');
    const id = seg[1] === 'video' ? seg[2] : seg[1];
    if (/^\d{4,}$/.test(id || '')) return { embedUrl: `https://player.vimeo.com/video/${id}`, provider: 'Vimeo' };
  }
  return { embedUrl: '', provider: '' };
}

/** The iframe-embed host allow-list (for a host-side sanity check / docs). */
export const EMBED_HOSTS = Object.freeze(['www.youtube-nocookie.com', 'player.vimeo.com', 'www.kaltura.com', 'cdnapisec.kaltura.com']);

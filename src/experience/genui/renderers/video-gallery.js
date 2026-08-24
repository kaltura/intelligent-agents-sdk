/**
 * Default renderer for the `video-gallery` runtime
 * (backend tool key "video_gallery" → `video-gallery-tool`). A gallery of
 * Kaltura clips. Each item's thumbnail/playback URL is scheme-checked via
 * `safeUrl`. When only an `entryId` is given (the common case — the brain knows
 * the id, not the CDN URL) AND a `partnerId` is in the render `ctx`, the
 * thumbnail and a player-embed URL are DERIVED from the id, so the gallery shows
 * a real thumbnail and can open a real Kaltura player. Framework-agnostic
 * `{kind:'video-gallery', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';
import { thumbnailUrl, playerEmbedUrl } from '../../../core/kaltura-media.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}, partnerId?:string|number, uiConfId?:string|number}} [ctx]
 * @returns {{kind:'video-gallery', data:{title:string, videos:Array<{entryId:string,title:string,thumbnailUrl:string,url:string,embedUrl:string,duration:string,description:string,alt:string}>}}}
 */
export function renderVideoGallery(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const pid = ctx.partnerId;
  const src = Array.isArray(model.videos) ? model.videos
    : Array.isArray(model.entries) ? model.entries
      : Array.isArray(model.items) ? model.items
        : [];
  const videos = src.map((v) => {
    const o = /** @type {Record<string,unknown>} */ ((v && typeof v === 'object') ? v : { title: v });
    const title = safeText(o.title ?? o.name ?? '', 500);
    const entryId = safeText(o.entryId ?? o.entry_id ?? o.id ?? '', 100);
    // Prefer an explicit thumbnail; else derive the canonical CDN thumbnail from the id+partnerId.
    const thumb = safeUrl(o.thumbnailUrl ?? o.thumbnail ?? o.thumb ?? '', ctx.urlPolicy || {})
      || (pid ? thumbnailUrl(entryId, pid, { width: 480 }) : '');
    return {
      entryId,
      title,
      thumbnailUrl: thumb,
      url: safeUrl(o.url ?? o.playUrl ?? o.link ?? '', ctx.urlPolicy || {}),
      // A real Kaltura player iframe src derived from the entry id (when partnerId is known).
      embedUrl: pid ? playerEmbedUrl(entryId, pid, { uiConfId: ctx.uiConfId }) : '',
      // string-keep duration to tolerate both "1:23" and a seconds count
      duration: safeText(o.duration ?? o.length ?? '', 40),
      description: safeText(o.description ?? '', 2000),
      alt: safeText(o.alt ?? title, 300),   // accessible name for the thumbnail <img>
    };
  });
  return { kind: 'video-gallery', data: { title: safeText(model.title ?? '', 300), videos } };
}

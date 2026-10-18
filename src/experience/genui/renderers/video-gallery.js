/**
 * Default renderer for the `video-gallery` runtime
 * (`video-gallery-tool`). A gallery of
 * Kaltura clips. Each item's thumbnail/playback URL is scheme-checked via
 * `safeUrl`. When only an `entryId` is given (the common case — the brain knows
 * the id, not the CDN URL) AND a `partnerId` is in the render `ctx`, the
 * thumbnail and a player-embed URL are DERIVED from the id, so the gallery shows
 * a real thumbnail and can open a real Kaltura player. The list is `videos`,
 * `entries` or `items`, else the clips of `citation.clips` or `clips`
 * (`startTime`/`endTime` in seconds). Framework-agnostic `{kind:'video-gallery', data}`.
 * `renderClips` is the same clip mapping for other widgets (flashcards, content-gallery).
 */
import { safeText, safeUrl } from '../../../core/safety.js';
import { thumbnailUrl, playerEmbedUrl } from '../../../core/kaltura-media.js';

/**
 * @typedef {{entryId:string, startTime:number|null, endTime:number|null, thumbnailUrl:string, url:string, embedUrl:string}} GenUIClip
 * A playable span of one Kaltura entry. `startTime` and `endTime` are seconds, or `null` when absent.
 */

/**
 * @typedef {{urlPolicy?:{allow?:string[]}, partnerId?:string|number, uiConfId?:string|number}} GenUIRenderCtx
 */

/**
 * A finite number of seconds ≥ 0 from a number or numeric string, else `null`.
 * @param {unknown} v
 * @returns {number|null}
 */
function seconds(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The playable fields shared by a gallery video and a clip.
 * @param {Record<string, unknown>} o
 * @param {GenUIRenderCtx} ctx
 * @returns {GenUIClip}
 */
function clipFields(o, ctx) {
  const pid = ctx.partnerId;
  const entryId = safeText(o.entryId ?? o.entry_id ?? o.id ?? '', 100);
  // Prefer an explicit thumbnail; else derive the canonical CDN thumbnail from the id+partnerId.
  const thumb = safeUrl(o.thumbnailUrl ?? o.thumbnail ?? o.thumb ?? '', ctx.urlPolicy || {})
    || (pid ? thumbnailUrl(entryId, pid, { width: 480 }) : '');
  return {
    entryId,
    startTime: seconds(o.startTime ?? o.start_time ?? o.start),
    endTime: seconds(o.endTime ?? o.end_time ?? o.end),
    thumbnailUrl: thumb,
    url: safeUrl(o.url ?? o.playUrl ?? o.link ?? o.video_link ?? '', ctx.urlPolicy || {}),
    // A real Kaltura player iframe src derived from the entry id (when partnerId is known).
    embedUrl: pid ? playerEmbedUrl(entryId, pid, { uiConfId: ctx.uiConfId }) : '',
  };
}

/**
 * Map a wire `clips` list to safe clip descriptors. A clip with neither an entry id nor a URL is dropped. Never throws.
 * @param {unknown} list
 * @param {GenUIRenderCtx} [ctx]
 * @returns {GenUIClip[]} `[]` when `list` is not an array.
 */
export function renderClips(list, ctx = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const clip = clipFields(/** @type {Record<string, unknown>} */ (c), ctx);
    if (clip.entryId || clip.url) out.push(clip);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} model
 * @param {GenUIRenderCtx} [ctx]
 * @returns {{kind:'video-gallery', data:{title:string, videos:Array<GenUIClip & {title:string,duration:string,description:string,alt:string}>}}}
 */
export function renderVideoGallery(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const citation = (model.citation && typeof model.citation === 'object') ? /** @type {Record<string, unknown>} */ (model.citation) : {};
  const src = Array.isArray(model.videos) ? model.videos
    : Array.isArray(model.entries) ? model.entries
      : Array.isArray(model.items) ? model.items
        : Array.isArray(citation.clips) ? citation.clips
          : Array.isArray(model.clips) ? model.clips
            : [];
  const videos = src.map((v) => {
    const o = /** @type {Record<string,unknown>} */ ((v && typeof v === 'object') ? v : { title: v });
    const title = safeText(o.title ?? o.name ?? '', 500);
    return {
      ...clipFields(o, ctx),
      title,
      // string-keep duration to tolerate both "1:23" and a seconds count
      duration: safeText(o.duration ?? o.length ?? '', 40),
      description: safeText(o.description ?? '', 2000),
      alt: safeText(o.alt ?? title, 300),   // accessible name for the thumbnail <img>
    };
  });
  return { kind: 'video-gallery', data: { title: safeText(model.title ?? '', 300), videos } };
}

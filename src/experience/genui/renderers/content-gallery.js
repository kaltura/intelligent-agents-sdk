/**
 * Default renderer for the `content-gallery` runtime
 * (backend tool key "gallery_slides" → `content-gallery-tool`). A deck/gallery
 * of content slides/cards. Each item's image/link URL is scheme-checked.
 * Framework-agnostic `{kind:'content-gallery', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}}} [ctx]
 * @returns {{kind:'content-gallery', data:{title:string, items:Array<{id:string,title:string,description:string,imageUrl:string,url:string,alt:string}>}}}
 */
export function renderContentGallery(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.items) ? model.items
    : Array.isArray(model.slides) ? model.slides
      : Array.isArray(model.cards) ? model.cards
        : [];
  const items = src.map((c) => {
    const o = /** @type {Record<string,unknown>} */ ((c && typeof c === 'object') ? c : { title: c });
    const title = safeText(o.title ?? o.name ?? o.heading ?? '', 500);
    const description = safeText(o.description ?? o.text ?? o.body ?? '', 2000);
    return {
      // slides are ordered/addressable (backend key gallery_slides) — preserve an id so a
      // host can deep-link/highlight one, mirroring video-gallery's entryId.
      id: safeText(o.id ?? o.slideId ?? o.key ?? '', 100),
      title,
      description,
      imageUrl: safeUrl(o.imageUrl ?? o.image ?? o.thumbnail ?? '', ctx.urlPolicy || {}),
      url: safeUrl(o.url ?? o.link ?? o.href ?? '', ctx.urlPolicy || {}),
      alt: safeText(o.alt ?? title ?? description, 300),   // accessible name for the <img>
    };
  });
  return { kind: 'content-gallery', data: { title: safeText(model.title ?? '', 300), items } };
}

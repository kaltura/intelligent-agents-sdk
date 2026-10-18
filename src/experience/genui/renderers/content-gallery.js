/**
 * Default renderer for the `content-gallery` runtime
 * (`content-gallery-tool`). A deck/gallery
 * of content slides/cards. Each item's image/link URL is scheme-checked.
 * A slide's text keeps its line breaks. A video slide carries `clips` (see
 * `renderClips`); the first clip fills `imageUrl` and `url` when the slide has
 * none. Items with no content at all are dropped.
 * Framework-agnostic `{kind:'content-gallery', data}`.
 */
import { safeText, safeSource, safeUrl } from '../../../core/safety.js';
import { renderClips } from './video-gallery.js';

/**
 * @param {Record<string, unknown>} model
 * @param {import('./video-gallery.js').GenUIRenderCtx} [ctx]
 * @returns {{kind:'content-gallery', data:{title:string, items:Array<{id:string,type:string,title:string,description:string,imageUrl:string,url:string,alt:string,clips?:import('./video-gallery.js').GenUIClip[]}>}}}
 */
export function renderContentGallery(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.items) ? model.items
    : Array.isArray(model.slides) ? model.slides
      : Array.isArray(model.cards) ? model.cards
        : [];
  const items = [];
  for (const c of src) {
    const o = /** @type {Record<string,unknown>} */ ((c && typeof c === 'object') ? c : { title: c });
    const title = safeText(o.title ?? o.name ?? o.heading ?? '', 500);
    const description = safeSource(o.description ?? o.text ?? o.body ?? '', 2000);
    const citation = (o.citation && typeof o.citation === 'object') ? /** @type {Record<string, unknown>} */ (o.citation) : {};
    const clips = renderClips(Array.isArray(citation.clips) ? citation.clips : o.clips, ctx);
    // slides are ordered/addressable, so preserve an id so a
    // host can deep-link/highlight one, mirroring video-gallery's entryId.
    const id = safeText(o.id ?? o.slideId ?? o.key ?? '', 100);
    const imageUrl = safeUrl(o.imageUrl ?? o.image ?? o.thumbnail ?? '', ctx.urlPolicy || {}) || (clips[0] ? clips[0].thumbnailUrl : '');
    const url = safeUrl(o.url ?? o.link ?? o.href ?? '', ctx.urlPolicy || {}) || (clips[0] ? clips[0].url : '');
    if (!id && !title && !description && !imageUrl && !url && !clips.length) continue;
    items.push({
      id,
      type: safeText(o.slide_type ?? o.type ?? '', 40),
      title,
      description,
      imageUrl,
      url,
      alt: safeText(o.alt ?? title ?? description, 300),   // accessible name for the <img>
      ...(clips.length ? { clips } : {}),
    });
  }
  return { kind: 'content-gallery', data: { title: safeText(model.title ?? '', 300), items } };
}

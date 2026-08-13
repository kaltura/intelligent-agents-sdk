/**
 * Default renderer for the `external-video` runtime
 * (backend tool key "external_video" → `external-video-tool`). Embeds a
 * non-Kaltura video. When the URL is a recognized embed host (YouTube/Vimeo)
 * it emits an `embedUrl` the host renders as a real `<iframe>` PLAYER; otherwise
 * it falls back to a scheme-checked link (`url`). The media URL is scheme-checked
 * client-side as defense-in-depth — the SERVER-side media-URL validator is the
 * primary guard (INFERRED — server validator not in this repo, see
 * docs/GENUI-REFERENCE.md §7 "external-video"); this client allow-list is an
 * additional layer. `safe:false` + empty url means the host must not embed.
 * Framework-agnostic `{kind:'external-video', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';
import { externalEmbedUrl } from '../../../core/kaltura-media.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}}} [ctx]
 * @returns {{kind:'external-video', data:{url:string, embedUrl:string, title:string, provider:string, poster:string, description:string, safe:boolean}}}
 */
export function renderExternalVideo(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const rawUrl = model.url ?? model.videoUrl ?? model.mediaUrl ?? model.src ?? model.embedUrl ?? '';
  // External embeds are an iframe/<video src> surface — require an ABSOLUTE http(s) URL.
  // safeUrl already blocks dangerous schemes + `//host`; this also rejects relative paths
  // (`/v`, `foo/v`) which must never become an embed src.
  const url = /^https?:\/\//i.test(String(rawUrl)) ? safeUrl(rawUrl, { allow: (ctx.urlPolicy && ctx.urlPolicy.allow) || ['https', 'http'] }) : '';
  // Promote a known embed host (YouTube/Vimeo) to a real iframe-embed URL so the host
  // renders an actual player. Unknown hosts → embedUrl:'' → the host shows a link.
  const embed = externalEmbedUrl(url);
  return {
    kind: 'external-video',
    data: {
      url,
      embedUrl: embed.embedUrl,
      title: safeText(model.title ?? model.name ?? '', 500),
      provider: safeText(model.provider ?? model.source ?? embed.provider ?? '', 100),
      poster: safeUrl(model.poster ?? model.thumbnail ?? model.thumbnailUrl ?? '', ctx.urlPolicy || {}),
      description: safeText(model.description ?? '', 2000),
      safe: !!url,
    },
  };
}

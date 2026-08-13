/**
 * Default renderer for the `show-link` runtime (backend tool key "show_link" →
 * `show-link-tool`). A single link card. The href is scheme-checked via
 * `safeUrl` (the classic XSS link vector — `javascript:`/`data:` → ''); when the
 * URL is unsafe the descriptor reports `safe:false` with an empty url so the
 * host can drop it (mirrors the earnings app's `renderSafeLink` null-drop).
 * Framework-agnostic `{kind:'show-link', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}}} [ctx]
 * @returns {{kind:'show-link', data:{url:string, label:string, description:string, safe:boolean}}}
 */
export function renderShowLink(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const rawUrl = model.url ?? model.linkUrl ?? model.link ?? model.href ?? model.mediaUrl ?? '';
  const url = safeUrl(rawUrl, ctx.urlPolicy || {});
  const label = safeText(model.label ?? model.linkText ?? model.title ?? model.text ?? url, 300);
  return {
    kind: 'show-link',
    data: {
      url,
      label,
      description: safeText(model.description ?? '', 2000),
      safe: !!url,
    },
  };
}

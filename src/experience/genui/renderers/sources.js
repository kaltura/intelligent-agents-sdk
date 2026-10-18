/**
 * Default renderer for the `sources` runtime (`sources-tool`). Citation cards for retrieved sources: web URLs or
 * entries. An entry source also keeps `entryId`, `type`, `duration` (seconds) and `hasShort`, each omitted when
 * absent. No URL is derived from an entry id. URLs are
 * scheme-checked via `safeUrl` (an unsafe `javascript:`/`data:` href becomes '',
 * never survives — OWASP LLM05). Framework-agnostic `{kind:'sources', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}}} [ctx]
 * @returns {{kind:'sources', data:{sources:Array<{title:string,url:string,snippet:string,score?:number,entryId?:string,type?:string,duration?:number,hasShort?:boolean}>}}}
 */
export function renderSources(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.sources) ? model.sources
    : Array.isArray(model.items) ? model.items
      : Array.isArray(model.citations) ? model.citations
        : [];
  const sources = src.map((s) => {
    const o = /** @type {Record<string,unknown>} */ ((s && typeof s === 'object') ? s : { title: s });
    // Forward-compatible passthrough: RAG retrieval may carry a relevance score so a host can
    // rank/badge citations. Absent or non-numeric → field omitted (NOT 0). A host
    // must not rely on a score being present (see docs/genui/widgets.md § sources).
    const score = Number(o.score ?? o.relevance ?? o.similarity);
    const entryId = safeText(o.entryId ?? o.entry_id ?? '', 100);
    const type = safeText(o.type ?? '', 40);
    const hasShort = o.hasShort ?? o.has_short;
    return {
      title: safeText(o.title ?? o.name ?? o.label ?? '', 500),
      url: safeUrl(o.url ?? o.link ?? o.href ?? '', ctx.urlPolicy || {}),
      snippet: safeText(o.snippet ?? o.text ?? o.content ?? '', 2000),
      ...(Number.isFinite(score) ? { score } : {}),
      ...(entryId ? { entryId } : {}),
      ...(type ? { type } : {}),
      ...(typeof o.duration === 'number' && Number.isFinite(o.duration) && o.duration >= 0 ? { duration: o.duration } : {}),
      ...(typeof hasShort === 'boolean' ? { hasShort } : {}),
    };
  });
  return { kind: 'sources', data: { sources } };
}

/**
 * Default renderer for the `sources` runtime (backend tool key "sources" →
 * `sources-tool`). Citation cards for RAG-retrieved sources. URLs are
 * scheme-checked via `safeUrl` (an unsafe `javascript:`/`data:` href becomes '',
 * never survives — OWASP LLM05). Framework-agnostic `{kind:'sources', data}`.
 */
import { safeText, safeUrl } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @param {{urlPolicy?:{allow?:string[]}}} [ctx]
 * @returns {{kind:'sources', data:{sources:Array<{title:string,url:string,snippet:string,score?:number}>}}}
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
    // rank/badge citations. Absent or non-numeric → field omitted (NOT 0). Not a claimed
    // backend guarantee — emission is unverified (see GENUI-REFERENCE "Restrictions").
    const score = Number(o.score ?? o.relevance ?? o.similarity);
    return {
      title: safeText(o.title ?? o.name ?? o.label ?? '', 500),
      url: safeUrl(o.url ?? o.link ?? o.href ?? '', ctx.urlPolicy || {}),
      snippet: safeText(o.snippet ?? o.text ?? o.content ?? '', 2000),
      ...(Number.isFinite(score) ? { score } : {}),
    };
  });
  return { kind: 'sources', data: { sources } };
}

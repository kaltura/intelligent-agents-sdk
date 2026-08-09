/**
 * fakeFetch — a deterministic, offline `fetch` for unit/integration tests. You
 * register route handlers keyed by a substring of the URL; each returns
 * `{status?, body?, headers?}`. Records every call for assertions. No network.
 */

/**
 * @param {Array<{match:string|RegExp, respond:(req:{url:string,method:string,headers:Record<string,string>,body:any})=>{status?:number,body?:any,headers?:Record<string,string>}}>} routes
 */
export function fakeFetch(routes) {
  /** @type {{url:string,method:string,headers:Record<string,string>,body:any}[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fn = async (url, init = {}) => {
    const headers = normalizeHeaders(init.headers);
    let body = init.body;
    if (typeof body === 'string' && /json/.test(headers['content-type'] || '')) {
      try { body = JSON.parse(body); } catch { /* leave as string */ }
    }
    const req = { url: String(url), method: init.method || 'GET', headers, body };
    calls.push(req);
    const route = routes.find((r) => (r.match instanceof RegExp ? r.match.test(req.url) : req.url.includes(r.match)));
    if (!route) return makeResponse(404, { message: `no fake route for ${req.url}` });
    const out = route.respond(req) || {};
    return makeResponse(out.status ?? 200, out.body ?? null, out.headers);
  };
  fn.calls = calls;
  return fn;
}

/** @param {number} status @param {any} body @param {Record<string,string>} [extraHeaders] */
function makeResponse(status, body, extraHeaders = {}) {
  const isString = typeof body === 'string';
  const text = body == null ? '' : (isString ? body : JSON.stringify(body));
  const headers = new Map(Object.entries({ 'content-type': isString ? 'text/plain' : 'application/json', ...lc(extraHeaders) }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    text: async () => text,
    json: async () => (isString ? JSON.parse(text) : body),
    body: streamFrom(text),
  };
}

/** Build a ReadableStream<Uint8Array> from a string (for converse-stream tests). @param {string} text */
export function streamFrom(text) {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(enc.encode(text));
    },
  });
}

/** Build a ReadableStream that emits an array of chunks (to test multi-read parsing). @param {string[]} chunks */
export function streamFromChunks(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

function normalizeHeaders(h) {
  /** @type {Record<string,string>} */ const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach((v, k) => { out[String(k).toLowerCase()] = v; }); return out; }
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  return out;
}
function lc(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k.toLowerCase()] = v; return r; }

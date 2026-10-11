/**
 * fakeWhepFetch: a scripted `fetch` for the WHEP endpoint. Each POST takes the next step from
 * `steps` (the last step repeats), so a test can model a slow answer, a dropped connection, an
 * HTTP error, or a POST the server accepted but whose response never arrived.
 *
 * A step is `{ status?, sdp?, location?, delayMs?, reset?, hang? }`:
 *
 * | field | effect |
 * |---|---|
 * | `status` | HTTP status (default 201) |
 * | `sdp`, `location` | answer body and `Location` header (defaults: a fake answer, `<url>/viewer/<n>`) |
 * | `delayMs` | wait this long (a timer, so `mock.timers` controls it) before answering |
 * | `reset` | reject with a network `TypeError` after `delayMs` |
 * | `hang` | never answer; the call ends only when its `signal` aborts |
 *
 * Requests that are not WHEP (`match`, default `/whep|rtc\/v1/`) go to `fallback`. A DELETE
 * answers `deleteStatus` (default 200). Every call is recorded with its method, URL, headers
 * and `keepalive` flag, and whether its signal aborted.
 */

/**
 * @param {Array<{status?:number, sdp?:string, location?:string, delayMs?:number, reset?:boolean, hang?:boolean}>} steps
 * @param {{match?:RegExp, deleteStatus?:number, fallback?:typeof fetch}} [opts]
 */
export function fakeWhepFetch(steps, opts = {}) {
  const match = opts.match || /whep|rtc\/v1/;
  /** @type {Array<{url:string, method:string, headers:Record<string,string>, body:any, keepalive:boolean, aborted:boolean}>} */
  const calls = [];
  let posts = 0;

  /** @type {typeof fetch} */
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (!match.test(u)) {
      if (opts.fallback) return opts.fallback(url, init);
      return response(404, '');
    }
    const call = { url: u, method: init.method || 'GET', headers: lowerHeaders(init.headers), body: init.body, keepalive: !!init.keepalive, aborted: false };
    calls.push(call);

    if (call.method === 'DELETE') return response(opts.deleteStatus ?? 200, '');

    const step = steps[Math.min(posts, steps.length - 1)] || {};
    posts += 1;
    const signal = init.signal;
    await new Promise((resolve, reject) => {
      const abort = () => { call.aborted = true; reject(abortError()); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (step.hang) return;
      const finish = () => {
        signal?.removeEventListener('abort', abort);
        if (step.reset) reject(new TypeError('fetch failed'));
        else resolve(undefined);
      };
      if (step.delayMs) setTimeout(finish, step.delayMs); else finish();
    });
    const status = step.status ?? 201;
    const ok = status >= 200 && status < 300;
    return response(status, ok ? (step.sdp ?? 'v=0\r\nfake-answer\r\n') : 'whep error', ok ? { location: step.location ?? `${u.replace(/\/$/, '')}/viewer/${posts}` } : {});
  };
  fn.calls = calls;
  /** POSTs the fake has seen. */
  Object.defineProperty(fn, 'posts', { get: () => calls.filter((c) => c.method === 'POST') });
  /** DELETEs the fake has seen. */
  Object.defineProperty(fn, 'deletes', { get: () => calls.filter((c) => c.method === 'DELETE') });
  return fn;
}

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** @param {number} status @param {string} text @param {Record<string,string>} [headers] */
function response(status, text, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function lowerHeaders(h) {
  /** @type {Record<string,string>} */ const out = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

// Shared helpers for the feature pages. Every page text goes in with textContent, never innerHTML.

/** @param {string} id */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @returns {Promise<any>} The page config: tokens and base URLs, no secrets beyond one conversation token. */
export async function getConfig() {
  const res = await fetch(new URL('../../api/config', location.href));
  if (!res.ok) throw new Error(`config failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Call an admin-side endpoint on the local server.
 * @param {string} name @param {unknown} [body] POST when a body is given.
 * @returns {Promise<any>}
 */
export async function api(name, body) {
  const res = await fetch(new URL(`../../api/${name}`, location.href), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Append one line to a `<ul class="log">`. @param {string} id @param {string} text @param {'ok'|'bad'} [kind] */
export function logLine(id, text, kind) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.textContent = text;
  $(id).append(li);
}

/** Fill a two-column table body. @param {string} id @param {Array<[string, unknown]>} rows */
export function fillRows(id, rows) {
  const body = $(id);
  body.replaceChildren();
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = k;
    const td = document.createElement('td'); td.textContent = v === undefined || v === null ? '(none)' : String(v);
    tr.append(th, td);
    body.append(tr);
  }
}

/**
 * A fetch that records each call as "METHOD host/path" (no query, no headers) and counts them.
 * @param {(line: string) => void} [onCall]
 */
export function countingFetch(onCall) {
  const calls = [];
  const wrapped = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const line = `${(init?.method || 'GET').toUpperCase()} ${url.host}${url.pathname}`;
    calls.push(line);
    onCall?.(line);
    return fetch(input, init);
  };
  return { fetch: wrapped, calls };
}

/** Mark the page ready for the automated run. */
export function ready() { document.body.dataset.ready = 'true'; }

/** Turn an error into a short line. @param {any} err */
export function describe(err) { return `${err?.code ?? err?.name ?? 'error'}: ${err?.detail || err?.message || err}`; }

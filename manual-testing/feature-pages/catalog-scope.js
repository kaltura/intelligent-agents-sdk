import { $, api, fillRows, logLine, ready, describe } from './common.js';

async function refresh() {
  const st = await api('catalog-state');
  if (!st.ready) return;
  const label = (scope) => (scope === st.scopeA ? 'scope A' : scope === st.scopeB ? 'scope B' : scope ? 'other' : 'none');
  fillRows('state', [
    ['item name', st.name],
    ['item scope', label(st.scope)],
    ['listed in scope A', st.inListA],
    ['listed in scope B', st.inListB],
    ['listed with no scope filter', st.inListNone],
  ]);
  const img = $('thumb');
  if (st.thumbnail) { if (img.getAttribute('src') !== st.thumbnail) img.setAttribute('src', st.thumbnail); img.hidden = false; }
  document.body.dataset.scope = label(st.scope);
}
const buttons = [...document.querySelectorAll('button')];
async function run(label, fn) {
  for (const b of buttons) b.disabled = true;
  try { await fn(); await refresh(); logLine('log', `${label}: done`, 'ok'); } catch (err) { logLine('log', `${label}: ${describe(err)}`, 'bad'); } finally { for (const b of buttons) b.disabled = false; }
  document.body.dataset.step = label;
}
$('create').addEventListener('click', () => run('create', () => api('catalog-init', {})));
$('toB').addEventListener('click', () => run('toB', () => api('catalog-scope', { to: 'B' })));
$('clear').addEventListener('click', () => run('clear', () => api('catalog-scope', { to: 'none' })));
ready();

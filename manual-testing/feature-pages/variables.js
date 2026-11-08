import { $, api, ready, describe } from './common.js';

function fill(id, rows, cols) {
  const body = $(id);
  body.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      const v = r[c];
      td.textContent = Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v);
      tr.append(td);
    }
    body.append(tr);
  }
}

$('load').addEventListener('click', async () => {
  $('status').textContent = 'Loading...';
  try {
    const v = await api('variables');
    fill('system', v.systemVariables ?? [], ['name', 'type', 'used', 'description']);
    fill('custom', (v.customVariables ?? []).map((c) => ({ ...c, sources: (c.sources ?? []).map((x) => `${x.documentType}.${x.field}`) })), ['name', 'type', 'origins', 'sources']);
    $('status').textContent = `${v.systemVariables?.length ?? 0} system, ${v.customVariables?.length ?? 0} custom`;
    document.body.dataset.loaded = 'true';
  } catch (err) {
    $('status').textContent = describe(err);
  }
});
ready();

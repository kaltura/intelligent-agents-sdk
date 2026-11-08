/**
 * Render one self-contained HTML report from raw eval results and their analysis.
 * No script, no external request, no font or image file. Every text value is escaped.
 * Closed `<details>` hide the turn lists; pass `expandAll` to open them for printing.
 */
import { EMOTIONS } from './scenarios.mjs';
import { turnFacts } from './analyze.mjs';

/** Escape text for HTML text and attribute positions. @param {unknown} v */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** @param {number|null|undefined} x */
const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${Math.round(x * 100)}%`);
/** @param {number|null|undefined} x */
const ms = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${Math.round(x)} ms`);
/** @param {{rate:number|null, lo:number, hi:number}} ci */
const ciText = (ci) => (ci.rate === null ? 'no data' : `${pct(ci.rate)} (${pct(ci.lo)} to ${pct(ci.hi)})`);
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const STATUS = {
  PASS: { icon: '✔', cls: 'good', text: 'PASS' },
  FAIL: { icon: '✖', cls: 'bad', text: 'FAIL' },
  INCONCLUSIVE: { icon: '?', cls: 'warn', text: 'UNDECIDED' },
  NO_DATA: { icon: '–', cls: 'warn', text: 'NO DATA' },
  UNSCORED: { icon: '·', cls: 'mute', text: 'NOT SCORED' },
};
/** @param {string} s */
function badge(s) {
  const m = /** @type {any} */ (STATUS)[s] ?? STATUS.NO_DATA;
  return `<span class="badge ${m.cls}"><span aria-hidden="true">${m.icon}</span> ${m.text}</span>`;
}

const GLYPH = { neutral: '◦', happy: '☺', sad: '☹', surprise: '!' };
/** @param {unknown} v @param {boolean|null} [accepted] */
function emoBadge(v, accepted = null) {
  const ok = typeof v === 'string' && /** @type {readonly string[]} */ (EMOTIONS).includes(v);
  const mark = accepted === null || !ok ? '' : accepted ? ' <span class="yes" title="accepted for this scenario">✓</span>' : ' <span class="no" title="not in the accepted set">✗</span>';
  if (!ok) return `<span class="emo invalid"><span aria-hidden="true">⚠</span> ${esc(typeof v === 'string' ? clip(v, 24) : JSON.stringify(v))}</span>`;
  return `<span class="emo e-${esc(v)}"><span aria-hidden="true">${/** @type {any} */ (GLYPH)[/** @type {string} */ (v)]}</span> ${esc(v)}</span>${mark}`;
}

/**
 * Group stored chunks into display segments: a segment starts at each avatar `segmentStart`.
 * @param {any[]} chunks
 * @returns {{kind:string, hasLabel:boolean, label?:unknown, text:string}[]}
 */
export function groupSegments(chunks) {
  /** @type {{kind:string, hasLabel:boolean, label?:unknown, text:string}[]} */
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const type = String(c?.type ?? 'unknown');
    const text = typeof c?.content === 'string' ? c.content : '';
    const labeled = c && Object.prototype.hasOwnProperty.call(c, 'emotion');
    const last = out[out.length - 1];
    if (type === 'avatar' && !c.segmentStart && last && last.kind === 'avatar') {
      last.text += text;
      if (labeled && !last.hasLabel) { last.hasLabel = true; last.label = c.emotion; }
    } else if (type === 'text' && last && last.kind === 'text') {
      last.text += text;
    } else {
      out.push({ kind: type, hasLabel: !!labeled, ...(labeled ? { label: c.emotion } : {}), text });
    }
  }
  return out;
}

/** @param {number} share */
function heatStyle(share) {
  const s = Math.max(0, Math.min(1, share));
  const mix = (/** @type {number} */ base) => Math.round(255 - s * (255 - base));
  const text = s >= 0.65 ? '#ffffff' : '#111111';
  return `background:rgb(${mix(8)},${mix(48)},${mix(107)});color:${text}`;
}

const CSS = `
:root{color-scheme:light;--ink:#1b1f24;--mute:#4b5563;--line:#d0d7de;--bg:#ffffff;--soft:#f6f8fa;--good:#116329;--goodbg:#dafbe1;--bad:#a40e26;--badbg:#ffebe9;--warn:#7d4e00;--warnbg:#fff1c2;--info:#0b4fb3;--infobg:#ddf4ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:18px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin:0}
.sub{color:var(--mute);margin:0 0 12px;font-size:13px}
.banner{border:2px solid;border-radius:8px;padding:12px 16px;margin:12px 0;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.banner .big{font-size:26px;font-weight:700;letter-spacing:.3px}
.banner.good{background:var(--goodbg);border-color:var(--good);color:var(--good)}.banner.bad{background:var(--badbg);border-color:var(--bad);color:var(--bad)}.banner.warn{background:var(--warnbg);border-color:var(--warn);color:var(--warn)}
.banner p{margin:0;color:var(--ink);flex:1 1 320px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.card{border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--soft)}.card b{display:block;font-size:20px}.card span{font-size:12px;color:var(--mute)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}th{background:var(--soft)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;border-radius:4px;padding:1px 7px;font-weight:700;font-size:12px;border:1px solid;white-space:nowrap}
.badge.good{background:var(--goodbg);color:var(--good);border-color:var(--good)}.badge.bad{background:var(--badbg);color:var(--bad);border-color:var(--bad)}.badge.warn{background:var(--warnbg);color:var(--warn);border-color:var(--warn)}.badge.mute{background:var(--soft);color:var(--mute);border-color:var(--mute)}
.scroll{overflow-x:auto;max-width:100%}
ul.ins{list-style:none;margin:0;padding:0}ul.ins li{border-left:5px solid;padding:6px 10px;margin:6px 0;background:var(--soft)}
ul.ins li.bad{border-color:var(--bad)}ul.ins li.warn{border-color:var(--warn)}ul.ins li.info{border-color:var(--info)}
ul.ins .tag{font-weight:700;margin-right:6px}ul.ins .bad .tag{color:var(--bad)}ul.ins .warn .tag{color:var(--warn)}ul.ins .info .tag{color:var(--info)}
.emo{display:inline-block;border-radius:10px;padding:0 8px;font-size:12px;font-weight:600;border:1px solid var(--line);background:#fff;white-space:nowrap}
.emo.e-happy{border-color:#7a5c00;background:#fff4c2}.emo.e-sad{border-color:#0b4fb3;background:#ddf4ff}.emo.e-surprise{border-color:#8250df;background:#f1e8ff}.emo.e-neutral{border-color:#57606a;background:#eef0f2}.emo.invalid{border:2px dashed var(--bad);background:var(--badbg);color:var(--bad)}
.yes{color:var(--good);font-weight:700}.no{color:var(--bad);font-weight:700}
.heat td.c{text-align:center;font-variant-numeric:tabular-nums;min-width:62px}.heat td.acc{outline:2px solid #1b1f24;outline-offset:-3px}
details{border:1px solid var(--line);border-radius:6px;margin:8px 0;background:#fff}summary{cursor:pointer;padding:8px 10px;background:var(--soft);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
details .body{padding:8px 10px}.why{color:var(--mute);font-size:13px;margin:0 0 6px}
.seg{margin:2px 0}.seg .t{color:var(--mute)}.kind{font-size:11px;color:var(--mute);border:1px solid var(--line);border-radius:3px;padding:0 4px;margin-right:4px}
.prompt{max-width:260px;word-break:break-word}
svg{max-width:100%;height:auto}svg text{font:12px system-ui,sans-serif;fill:#1b1f24}
.legend{font-size:12px;color:var(--mute);margin:4px 0}
footer{margin-top:32px;color:var(--mute);font-size:12px}
.pill{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 8px;background:#fff}
@media print{body{font-size:11px}main{max-width:none;padding:0}details{break-inside:avoid}summary{background:#fff}h2{break-after:avoid}.banner,.card,.badge,.emo,.heat td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

/** @param {any} a */
function coverageSvg(a) {
  const rows = a.perScenario.filter((/** @type {any} */ s) => s.n > 0);
  if (!rows.length) return '<p class="legend">No scored turns.</p>';
  const rowH = 24, left = 230, plotW = 480, top = 22, h = top + rows.length * rowH + 20, w = left + plotW + 90;
  const x = (/** @type {number} */ v) => left + v * plotW;
  const target = a.thresholds.match.target;
  let g = `<line x1="${x(0)}" y1="${top - 6}" x2="${x(0)}" y2="${h - 18}" stroke="#57606a"/>`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) g += `<line x1="${x(t)}" y1="${top - 6}" x2="${x(t)}" y2="${h - 18}" stroke="#d0d7de" stroke-dasharray="2 3"/><text x="${x(t)}" y="${h - 4}" text-anchor="middle">${t * 100}%</text>`;
  g += `<line x1="${x(target)}" y1="${top - 10}" x2="${x(target)}" y2="${h - 18}" stroke="#a40e26" stroke-width="2"/><text x="${x(target)}" y="${top - 12}" text-anchor="middle" style="fill:#a40e26">target ${pct(target)}</text>`;
  rows.forEach((/** @type {any} */ s, i) => {
    const y = top + i * rowH + rowH / 2;
    const r = s.success_ci;
    g += `<text x="${left - 8}" y="${y + 4}" text-anchor="end">${esc(clip(s.title, 32))}</text>`;
    g += `<rect x="${x(0)}" y="${y - 7}" width="${Math.max(0, r.rate * plotW)}" height="14" fill="${s.status === 'FAIL' ? '#a40e26' : '#0b4fb3'}"${s.status === 'FAIL' ? ' fill-opacity="0.85"' : ''}/>`;
    g += `<line x1="${x(r.lo)}" y1="${y}" x2="${x(r.hi)}" y2="${y}" stroke="#111" stroke-width="2"/><line x1="${x(r.lo)}" y1="${y - 5}" x2="${x(r.lo)}" y2="${y + 5}" stroke="#111" stroke-width="2"/><line x1="${x(r.hi)}" y1="${y - 5}" x2="${x(r.hi)}" y2="${y + 5}" stroke="#111" stroke-width="2"/>`;
    const cov = s.coverage.rate ?? 0;
    g += `<path d="M${x(cov)} ${y - 6} l5 6 l-5 6 l-5 -6 z" fill="#fff" stroke="#111" stroke-width="1.5"/>`;
    g += `<text x="${left + plotW + 8}" y="${y + 4}">${s.success}/${s.n}</text>`;
  });
  const label = rows.map((/** @type {any} */ s) => `${s.title}: ${s.success} of ${s.n}`).join('; ');
  return `<svg role="img" aria-label="${esc(`Expected-emotion rate per scenario with 95% intervals. ${label}`)}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${g}</svg>
<p class="legend">Bar = turns with an accepted emotion. Whisker = 95% interval. ◇ = turns with any emotion (coverage). Dark red bar = interval entirely below 50%. Numbers on the right are turns.</p>`;
}

/** @param {any} a */
function latencySvg(a) {
  const l = a.latency;
  const items = [
    ['First chunk, off', l.off.first, '#57606a'], ['First chunk, on', l.on.first, '#0b4fb3'],
    ['Total, off', l.off.total, '#57606a'], ['Total, on', l.on.total, '#0b4fb3'],
    ['Total p90, off', l.off.totalP90, '#57606a'], ['Total p90, on', l.on.totalP90, '#0b4fb3'],
  ].filter((it) => Number.isFinite(it[1]));
  if (!items.length) return '<p class="legend">No latency data.</p>';
  const max = Math.max(...items.map((it) => /** @type {number} */ (it[1])), 1);
  const rowH = 24, left = 130, plotW = 520, h = items.length * rowH + 10, w = left + plotW + 90;
  let g = '';
  items.forEach((it, i) => {
    const y = 5 + i * rowH + rowH / 2;
    const bw = (/** @type {number} */ (it[1]) / max) * plotW;
    g += `<text x="${left - 8}" y="${y + 4}" text-anchor="end">${esc(it[0])}</text><rect x="${left}" y="${y - 7}" width="${bw}" height="14" fill="${it[2]}"/><text x="${left + bw + 6}" y="${y + 4}">${ms(/** @type {number} */ (it[1]))}</text>`;
  });
  const label = items.map((it) => `${it[0]} ${ms(/** @type {number} */ (it[1]))}`).join('; ');
  return `<svg role="img" aria-label="${esc(`Latency. ${label}`)}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

/** @param {any} a */
function heatmap(a) {
  const cols = [...EMOTIONS, 'none', 'invalid'];
  const head = cols.map((c) => `<th class="num">${esc(c === 'none' ? 'no label' : c)}</th>`).join('');
  const rows = a.perScenario.filter((/** @type {any} */ s) => s.n > 0).map((/** @type {any} */ s) => {
    const accept = new Set(a.accept?.[s.id] ?? []);
    const cells = cols.map((c) => {
      const k = s.labelTurns[c] ?? 0;
      const share = s.n ? k / s.n : 0;
      const isAcc = accept.has(c);
      const style = c === 'invalid' && k ? 'background:#a40e26;color:#fff' : heatStyle(share);
      return `<td class="c${isAcc ? ' acc' : ''}" style="${style}" title="${esc(`${s.title}: ${k} of ${s.n} turns, ${c}${isAcc ? ' (accepted)' : ''}`)}">${k}${isAcc ? ' ✓' : ''}</td>`;
    }).join('');
    return `<tr><th scope="row">${esc(s.title)}</th><td class="num">${s.n}</td>${cells}</tr>`;
  }).join('');
  return `<table class="heat"><thead><tr><th>Scenario</th><th class="num">turns</th>${head}</tr></thead><tbody>${rows}</tbody></table>
<p class="legend">Cell = number of turns that showed that label at least once. Darker = more turns. Outlined cell with ✓ = accepted label for the scenario. A turn with several labels counts in each column.</p>`;
}

/** @param {any} d */
function hardRow(d) {
  const bound = d.upperBound === null ? 'n/a' : d.violations === 0 ? `≤ ${pct(d.upperBound)}` : pct(d.rate);
  return `<tr><td>${esc(d.name)}</td><td class="num">${d.violations} / ${d.n}</td><td class="num" title="With zero violations this is the 95% upper bound on the true violation rate">${bound}</td><td>${badge(d.status)}</td></tr>`;
}

/** @param {any} d */
function softRow(d) {
  if (d.dir) return `<tr><td>${esc(d.name)}</td><td class="num">${d.k} / ${d.n}</td><td>${esc(ciText(d))}</td><td class="num">${d.dir === 'atLeast' ? '≥' : '≤'} ${pct(d.target)}</td><td>${badge(d.status)}</td></tr>`;
  return `<tr><td>${esc(d.name)}</td><td class="num">${d.n ?? ''}</td><td>see latency chart</td><td class="num">≤ ${ms(1500)}</td><td>${badge(d.status)}</td></tr>`;
}

/**
 * One scenario's drill-down.
 * @param {any} s scenario summary @param {any} spec scenario definition @param {any[]} turns @param {boolean} open
 */
function drill(s, spec, turns, open) {
  const specTurns = spec?.turns ?? [];
  const rows = turns.sort((p, q) => p.trial - q.trial || p.turnIndex - q.turnIndex || String(p.mode).localeCompare(String(q.mode))).map((t) => {
    const f = turnFacts(t);
    const acc = specTurns[t.turnIndex]?.accept ?? null;
    const segs = groupSegments(t.segments);
    const segHtml = !f.ok
      ? `<div class="seg"><span class="badge bad">ERROR</span> ${esc(clip(String(t.error?.code ?? (f.streamError ? 'error chunk' : '')), 40))} ${esc(clip(String(t.error?.message ?? f.streamError ?? ''), 160))}${f.toolSegments ? ` <span class="t">(after ${f.toolSegments} tool calls)</span>` : ''}</div>`
      : segs.length
        ? segs.map((g) => `<div class="seg"><span class="kind">${esc(g.kind)}</span>${g.kind === 'avatar' ? (g.hasLabel ? emoBadge(g.label, t.mode === 'on' && acc ? acc.includes(g.label) : null) : '<span class="emo">no label</span>') : ''} <span class="t">${esc(clip(g.text.trim(), 160))}</span></div>`).join('')
        : '<div class="seg"><span class="t">(no segments)</span></div>';
    return `<tr><td class="num">${esc(t.trial)}.${esc(t.turnIndex)}</td><td><span class="pill">${esc(t.mode)}</span></td><td class="prompt">${esc(clip(String(t.prompt ?? ''), 140))}</td><td>${segHtml}</td><td class="num">${ms(t.firstChunkMs)}<br>${ms(t.totalMs)}</td></tr>`;
  }).join('');
  const status = specTurns.some((/** @type {any} */ x) => x.edge === 'empty') ? 'UNSCORED' : s.status;
  const accept = [...new Set(specTurns.flatMap((/** @type {any} */ x) => x.accept ?? []))];
  return `<details id="s-${esc(s.id)}"${open ? ' open' : ''}><summary><h3>${esc(s.title)}</h3>${badge(status)} <span class="pill">${s.success}/${s.n} accepted</span> <span class="pill">pass^3 ${s.passK3 === null ? 'n/a' : pct(s.passK3)}</span>${s.flaky ? ' <span class="pill">flaky</span>' : ''}</summary>
<div class="body"><p class="why">${esc(spec?.why ?? '')} Accepted: ${accept.length ? esc(accept.join(', ')) : 'any valid label'}.</p>
<table><thead><tr><th>Trial.turn</th><th>Path</th><th>Prompt</th><th>Segments (label, text)</th><th class="num">First / total</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No turns.</td></tr>'}</tbody></table></div></details>`;
}

/**
 * Render the report.
 * @param {any} results raw results
 * @param {any} a the output of `analyze(results)`
 * @param {{expandAll?:boolean}} [opts]
 * @returns {string}
 */
export function renderReport(results, a, opts = {}) {
  const meta = results?.meta ?? {};
  const scenarios = Array.isArray(results?.scenarios) ? results.scenarios : [];
  const turns = Array.isArray(results?.turns) ? results.turns : [];
  a = { ...a, accept: Object.fromEntries(scenarios.map((/** @type {any} */ s) => [s.id, [...new Set((s.turns ?? []).flatMap((/** @type {any} */ x) => x.accept ?? []))]])) };
  const v = a.verdict;
  const cov = a.soft.coverage, mat = a.soft.match;
  const cards = [
    [String(a.counts.turns), 'turns recorded'],
    [String(meta.trials ?? '?'), 'trials per scenario'],
    [pct(cov.rate), cov.rate === null ? 'coverage (no data)' : `coverage, 95% interval ${pct(cov.lo)} to ${pct(cov.hi)}`],
    [pct(mat.rate), 'expected-label match'],
    [`${a.hard.leakage.violations}/${a.hard.leakage.n}`, 'off-state leaks'],
    [`${a.hard.validity.violations}/${a.hard.validity.n}`, 'invalid values'],
  ].map(([b, t]) => `<div class="card"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join('');
  const insights = a.insights.length
    ? `<ul class="ins">${a.insights.map((/** @type {any} */ i) => `<li class="${esc(i.level)}"><span class="tag">${i.level === 'bad' ? 'PROBLEM' : i.level === 'warn' ? 'WATCH' : 'NOTE'}</span>${esc(i.text)}</li>`).join('')}</ul>`
    : '<p>No insights. No data to read.</p>';
  const parser = (Array.isArray(results?.parserChecks) ? results.parserChecks : []).map((/** @type {any} */ c) => `<tr><td>${esc(c.name)}</td><td>${badge(c.pass ? 'PASS' : 'FAIL')}</td><td>${esc(c.detail)}</td></tr>`).join('');
  const drills = a.perScenario.map((/** @type {any} */ s) => drill(s, scenarios.find((/** @type {any} */ x) => x.id === s.id), turns.filter((/** @type {any} */ t) => t.scenario === s.id), !!opts.expandAll || s.status === 'FAIL' || s.flaky)).join('');
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  const wrapTables = (/** @type {string} */ x) => x.replace(/<table/g, '<div class="scroll"><table').replace(/<\/table>/g, '</table></div>');
  return wrapTables(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Avatar emotions eval: ${esc(v.label)}</title><style>${CSS}</style></head>
<body><main>
<h1>Avatar emotions eval</h1>
<p class="sub">Limited Availability feature. Employees and certified partners only. Target: ${esc(meta.target ?? 'unknown')}. Started: ${esc(meta.startedAt ?? 'unknown')}. ${esc(meta.trials ?? '?')} trials per scenario. ${esc(a.counts.turns)} turns.${meta.dryRun ? ' <b>Recorded fixture, not a live run.</b>' : ''}</p>
<div class="banner ${esc(v.tone)}" role="status"><span class="big">${esc(v.label)}</span><p>${esc(v.summary)} Exit code ${esc(v.exitCode)}.</p></div>${(a.notes ?? []).map((n) => `<div class="banner ${esc(n.level)}" role="alert"><p>${esc(n.text)}</p></div>`).join('')}
<div class="cards">${cards}</div>
<h2>Insights</h2>${insights}
<h2>Hard dimensions (must be 100%)</h2>
<table><thead><tr><th>Dimension</th><th class="num">Violations / checked</th><th class="num">Rate or 95% upper bound</th><th>Status</th></tr></thead><tbody>${Object.values(a.hard).map(hardRow).join('')}</tbody></table>
<h2>Quality dimensions (rates with 95% intervals)</h2>
<table><thead><tr><th>Dimension</th><th class="num">Count</th><th>Rate (95% interval)</th><th class="num">Target</th><th>Status</th></tr></thead><tbody>${Object.values(a.soft).map(softRow).join('')}</tbody></table>
<p class="legend">PASS = the whole interval is on the good side of the target. FAIL = the whole interval is on the bad side. UNDECIDED = the interval crosses the target, so more trials are needed.</p>
<h2>Scenario by label</h2>${heatmap(a)}
<h2>Expected-emotion rate per scenario</h2>${coverageSvg(a)}
<h2>Latency, emotions on vs off</h2>${latencySvg(a)}
<p class="legend">Paired comparison. Each emotions-off turn is matched to the emotions-on turn with the same scenario, trial and turn number, and only matched pairs count. Median of the per-pair total time difference (on minus off): ${a.latency.totalDiff ? `${Math.round(a.latency.totalDiff.diff)} ms, 95% interval ${Math.round(a.latency.totalDiff.lo)} to ${Math.round(a.latency.totalDiff.hi)} ms` : 'not enough pairs'}. Budget ${ms(a.latency.budgetMs)}. ${a.latency.pairs} pair(s) from ${a.latency.scenarios.length} scenario(s): ${esc(a.latency.scenarios.join(', ') || 'none')}. The bars show the medians of those same turns.</p>
<h2>Turns by scenario</h2><p class="legend">Failing and flaky scenarios start open. A scenario status compares the share of its scored turns that showed an accepted label (a turn with no label counts as a miss) with the 70% target, using the 95% interval.</p>${drills}
<h2>SDK parser checks (offline)</h2>
<table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${parser || '<tr><td colspan="3">Not run.</td></tr>'}</tbody></table>
<footer>Generated from the raw results file only. Accepted label sets are judgments, written with a reason per scenario in scenarios.mjs. Intervals are Wilson 95%. This page makes no network request and runs no script.</footer>
</main></body></html>
`);
}

// Builds `search-index.json` for the site's Cmd/Ctrl+K search: one record per
// page intro and per h2 section, from the HTML Eleventy just wrote. Zero
// dependencies. Reuses the manifest's text helpers so both read pages alike.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { textOf } from './sections-manifest.mjs';

export const SEARCH_INDEX_REL_PATH = 'search-index.json';

const MAIN_RE = /<main class="content-wrapper"[^>]*>([\s\S]*?)<\/main>/;
const FOOT_RE = /<footer class="page-foot">[\s\S]*?<\/footer>/;
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/;
const H2_RE = /^<h2\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/;
const EYEBROW_RE = /<div class="eyebrow">[\s\S]*?<\/div>/;
const MAX_TEXT = 600;
const MAX_CODE = 1500;
const PRE_RE = /<pre\b[\s\S]*?<\/pre>/g;
const CODE_RE = /<code\b[^>]*>([^<]*)<\/code>/g;

/**
 * @param {Array<{url:string, outputPath?:string, content:string}>} results Eleventy `eleventy.after` results.
 * @param {Map<string,string>} groupByUrl Page URL to sidebar group label.
 * @returns {Array<{u:string,t:string,h:string,g:string,x:string,k:string}>}
 */
export function buildSearchIndex(results, groupByUrl = new Map()) {
  const records = [];
  for (const r of results) {
    if (r.outputPath && !r.outputPath.endsWith('.html')) continue;
    const main = MAIN_RE.exec(r.content)?.[1];
    if (main == null) continue;
    const parts = main.replace(FOOT_RE, '').split(/(?=<h2\b)/);
    const title = textOf(H1_RE.exec(parts[0])?.[1] ?? '') || textOf(/<title>([\s\S]*?)<\/title>/.exec(r.content)?.[1] ?? '').split(' — ')[0];
    const g = groupByUrl.get(r.url) ?? '';
    for (const [i, part] of parts.entries()) {
      const h2 = i === 0 ? null : H2_RE.exec(part);
      if (i > 0 && !h2) continue;
      const body = h2 ? part.slice(h2[0].length) : part.replace(H1_RE, '').replace(EYEBROW_RE, '');
      records.push({
        u: h2 ? `${r.url}#${h2[1]}` : r.url,
        t: title,
        h: h2 ? textOf(h2[2]) : '',
        g,
        x: textOf(body).slice(0, MAX_TEXT),
        k: codeTerms(body),
      });
    }
  }
  return records;
}

/** Inline `code` identifiers in a section (API names, options), so a search for one finds the section even past the text cutoff. */
function codeTerms(html) {
  const seen = new Set();
  for (const m of html.replace(PRE_RE, '').matchAll(CODE_RE)) seen.add(textOf(m[1]));
  return [...seen].join(' ').slice(0, MAX_CODE);
}

export function writeSearchIndex(results, groupByUrl, outputDir) {
  const records = buildSearchIndex(results, groupByUrl);
  const file = join(outputDir, SEARCH_INDEX_REL_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records)}\n`);
  return { file, records: records.length };
}

// Markdown twins: every docs page is also written as `<page url>index.md`, the
// page's own markdown source with absolute links. Coding agents read these
// instead of the HTML. Built from the same source files as the HTML on every
// build, so a twin cannot drift from its page. `llms.txt.njk` and base.njk use
// `twinUrl` for their links, and scripts/check-markdown-twins.mjs fails the
// build if any page lacks a twin or any twin has a broken link.
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const FENCE_RE = /^\s*(```|~~~)/;
const MD_LINK_RE = /\]\((\/(?!\/)[^)\s#]*)(#[^)\s]*)?\)/g;
const HTML_ATTR_RE = /\b(href|src)="\/(?!\/)/g;

/** URL of a page's markdown twin, relative to the site root. */
const twinUrl = (pageUrl) => `${pageUrl}index.md`;

/**
 * @param {string} source Page file, front matter included.
 * @param {{siteUrl:string, pageUrls:Set<string>}} ctx `pageUrls` are the URLs that have a twin.
 */
function toTwin(source, { siteUrl, pageUrls }) {
  let inFence = false;
  return source.replace(FRONT_MATTER_RE, '').replace(/^\s+/, '').split('\n').map((line) => {
    if (FENCE_RE.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line
      .replace(MD_LINK_RE, (_, path, hash = '') => `](${siteUrl}${pageUrls.has(path) ? twinUrl(path) : path}${hash})`)
      .replace(HTML_ATTR_RE, `$1="${siteUrl}/`);
  }).join('\n');
}

/**
 * @param {Array<{url:string, inputPath:string}>} results Eleventy `eleventy.after` results.
 * @param {Set<string>} pageUrls URLs of the nav pages (the ones listed in llms.txt).
 * @returns {number} twins written
 */
function writeTwins(results, pageUrls, siteUrl, outputDir) {
  let n = 0;
  for (const r of results) {
    if (!pageUrls.has(r.url) || !r.inputPath.endsWith('.md')) continue;
    const file = join(outputDir, twinUrl(r.url));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toTwin(readFileSync(r.inputPath, 'utf8'), { siteUrl, pageUrls }));
    n++;
  }
  return n;
}

module.exports = { twinUrl, toTwin, writeTwins };

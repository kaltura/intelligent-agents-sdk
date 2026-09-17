const markdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');
const syntaxHighlight = require('@11ty/eleventy-plugin-syntaxhighlight');
// scripts/check-anchors.mjs verifies every in-site fragment against the built
// ids on each build. scripts/generate-docs.mjs imports this same function so
// its "On this page" quick-nav anchors can never drift from these.
const githubSlugify = require('./scripts/lib/github-slugify.js');

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('src/assets');

  // GitHub Pages serves this repo as a project site under /<repo>/, not at the
  // domain root, but every href/src in base.njk, nav.js, and the migrated docs
  // is root-absolute (e.g. "/getting-started/"). CI passes the real subpath via
  // ELEVENTY_PATH_PREFIX (from actions/configure-pages' base_path output); local
  // builds leave it unset, so this is a no-op for local preview. Shared with
  // src/_data/pathPrefix.js so the build-time transform and the runtime value
  // embedded in every page (for router.js/site-nav.js) can never drift.
  const pathPrefix = require('./src/_data/pathPrefix.js');
  if (pathPrefix) {
    eleventyConfig.addTransform('pathPrefix', (content, outputPath) => {
      if (!outputPath || !outputPath.endsWith('.html')) return content;
      return content.replace(/(href|src)="\/(?!\/)/g, `$1="${pathPrefix}/`);
    });
  }

  // Nova's go_to tool: every hand-placed data-nova-target gets a matching DOM id
  // (so the SDK's SiteNavigator can reach it by id), and the built pages are
  // distilled into _site/nova/sections.json, the manifest the tool navigates
  // against. Both live in scripts/lib/sections-manifest.mjs; the check script
  // scripts/check-sections-manifest.mjs rebuilds the manifest from _site and
  // fails the build on any drift.
  eleventyConfig.addTransform('novaTargetIds', async (content, outputPath) => {
    if (!outputPath || !outputPath.endsWith('.html')) return content;
    const { ensureTargetIds } = await import('./scripts/lib/sections-manifest.mjs');
    return ensureTargetIds(content);
  });
  eleventyConfig.on('eleventy.after', async ({ dir, results }) => {
    const { writeManifest } = await import('./scripts/lib/sections-manifest.mjs');
    const { file, pages, sections } = await writeManifest(results, dir.output);
    console.log(`[11ty] Wrote ${file} (${pages} pages, ${sections} sections)`);
  });

  const md = markdownIt({ html: true, breaks: false, linkify: true }).use(
    markdownItAnchor,
    { slugify: githubSlugify }
  );
  eleventyConfig.setLibrary('md', md);
  eleventyConfig.addPlugin(syntaxHighlight);

  // Site-authored cross-refs point at the sibling .md file, same as the
  // GitHub-rendered docs; rewrite to the site's clean output URLs.
  eleventyConfig.addFilter('siteLink', (href) => {
    if (typeof href !== 'string') return href;
    return href.replace(/([\w-]+)\.md(#[\w-]*)?$/, (_, file, anchor) => {
      return `/${file.toLowerCase()}/${anchor || ''}`;
    });
  });

  // Embeds routes.js as a JSON literal in base.njk's <head> (window.__SITE_ROUTES__)
  // — bare, unprefixed URLs; the pathPrefix transform above only rewrites
  // href=/src= attributes, so runtime code (router.js/site-nav.js) applies
  // its own withPrefix() to these before fetch()/pushState().
  eleventyConfig.addFilter('dump', (value) => JSON.stringify(value));

  // "On this page" rail: pulls real <h2 id> headings straight out of the
  // already-rendered content, so it can never drift from what markdown-it-anchor
  // (and check-anchors.mjs) actually assigned.
  eleventyConfig.addFilter('tocHeadings', (html) => {
    if (typeof html !== 'string') return [];
    const out = [];
    const re = /<h2[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g;
    let m;
    while ((m = re.exec(html))) {
      out.push({ id: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    return out;
  });

  // Sidebar tree: which nav-node urls are an ancestor of the current page, so
  // base.njk's recursive macro can auto-expand only the path down to the page
  // you're actually on instead of every <details> or none of them.
  eleventyConfig.addFilter('trailUrls', (crumb) => (crumb ? crumb.trail.map((t) => t.url) : []));

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      data: '_data',
    },
    // Markdown bodies are migrated docs, not templates — they contain literal
    // `{{var}}`/`{{secrets.X}}` syntax from the SDK's own docs, so Nunjucks must
    // not parse them. Only the layout (base.njk) still runs through Nunjucks.
    markdownTemplateEngine: false,
    htmlTemplateEngine: 'njk',
  };
};

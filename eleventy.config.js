const markdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');

// Mirrors GitHub's heading-slug algorithm so links copied verbatim from the
// original .md cross-refs (e.g. "#use-case-catalog") keep resolving on the site.
// Each space becomes its own hyphen, NOT collapsed: "Endpoints & Credentials"
// slugs to "endpoints--credentials" on GitHub (the "&" is stripped, leaving two
// spaces), and the migrated docs link to exactly that form.
// scripts/check-anchors.mjs verifies every in-site fragment against the built
// ids on each build.
function githubSlugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('src/assets');

  // GitHub Pages serves this repo as a project site under /<repo>/, not at the
  // domain root, but every href/src in base.njk, nav.js, and the migrated docs
  // is root-absolute (e.g. "/getting-started/"). CI passes the real subpath via
  // ELEVENTY_PATH_PREFIX (from actions/configure-pages' base_path output); local
  // builds leave it unset, so this is a no-op for local preview. Shared with
  // src/_data/pathPrefix.js so the build-time transform and the runtime value
  // embedded in every page (for router.js/navigator.js) can never drift.
  const pathPrefix = require('./src/_data/pathPrefix.js');
  if (pathPrefix) {
    eleventyConfig.addTransform('pathPrefix', (content, outputPath) => {
      if (!outputPath || !outputPath.endsWith('.html')) return content;
      return content.replace(/(href|src)="\/(?!\/)/g, `$1="${pathPrefix}/`);
    });
  }

  const md = markdownIt({ html: true, breaks: false, linkify: true }).use(
    markdownItAnchor,
    { slugify: githubSlugify }
  );
  eleventyConfig.setLibrary('md', md);

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
  // href=/src= attributes, so runtime code (router.js/navigator.js) applies
  // its own withPrefix() to these before fetch()/pushState().
  eleventyConfig.addFilter('dump', (value) => JSON.stringify(value));

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

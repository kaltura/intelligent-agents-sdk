const markdownIt = require('markdown-it');
const markdownItAnchor = require('markdown-it-anchor');

// Mirrors GitHub's heading-slug algorithm so links copied verbatim from the
// original .md cross-refs (e.g. "#use-case-catalog") keep resolving on the site.
function githubSlugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy('src/assets');

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

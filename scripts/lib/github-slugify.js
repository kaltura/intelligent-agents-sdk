// Mirrors GitHub's heading-slug algorithm so links copied verbatim from the
// original .md cross-refs (e.g. "#use-case-catalog") keep resolving on the site.
// Each space becomes its own hyphen, NOT collapsed: "Endpoints & Credentials"
// slugs to "endpoints--credentials" on GitHub (the "&" is stripped, leaving two
// spaces), and the migrated docs link to exactly that form.
// Shared by eleventy.config.js (markdown-it-anchor) and scripts/generate-docs.mjs
// (the "On this page" quick-nav) so both compute the exact same anchor.
function githubSlugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

module.exports = githubSlugify;

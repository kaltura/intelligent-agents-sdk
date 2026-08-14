// Single source of truth for the GitHub Pages project-site subpath — read by
// eleventy.config.js's build-time href/src transform AND embedded into every
// page (via base.njk) for runtime fetch()/pushState() calls (router.js,
// navigator.js), so the two can never drift out of sync.
module.exports = (process.env.ELEVENTY_PATH_PREFIX || '').replace(/\/$/, '');

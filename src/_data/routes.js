// Flattened, canonical list of every real route on this site — Home plus
// every page in nav.js. This is the ONE list both the client-side router
// (router.js) and the navigate_to_page tool handler (navigator.js) validate
// against, embedded into every page via base.njk as window.__SITE_ROUTES__.
const nav = require('./nav.js');

module.exports = [
  { title: 'Home', url: '/' },
  ...nav.flatMap((section) => section.pages),
];

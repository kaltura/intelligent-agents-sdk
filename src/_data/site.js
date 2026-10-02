// Absolute site URL for og:url, canonical and og:image. Social crawlers need
// absolute URLs, and the pathPrefix transform only rewrites href/src.
const pathPrefix = require('./pathPrefix.js');
module.exports = {
  url: `https://kaltura.github.io${pathPrefix || '/intelligent-agents-sdk'}`,
  name: '@kaltura/intelligent-agents',
  description: 'A zero-dependency JavaScript SDK for building and operating Kaltura Agentic Avatars: conversational agents with a visual, human-like avatar interface.',
  image: '/assets/img/og-card.jpg',
  imageAlt: 'Meet Nova, a live Kaltura Agentic Avatar built with this SDK, next to a message box and starter questions.',
};

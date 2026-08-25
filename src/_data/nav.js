// Hand-authored sidebar nav, grouped by Diátaxis quadrant (Tutorial → How-to
// Guides → Explanation → Reference — Diátaxis's own recommended reading order).
module.exports = [
  {
    group: 'Tutorial',
    pages: [{ title: 'Getting Started', url: '/getting-started/' }],
  },
  {
    group: 'How-to Guides',
    pages: [
      { title: 'Client-Side Commands', url: '/guides/client-commands/' },
      { title: 'Dynamic Data Injection', url: '/guides/dynamic-data-injection/' },
      { title: 'Voice Input Modes', url: '/guides/voice-input-modes/' },
      { title: 'Structured Data Forms', url: '/guides/structured-data-forms/' },
      { title: 'External API Integrations', url: '/guides/external-api-integrations/' },
      { title: 'Architecture Recipe', url: '/guides/architecture-recipe/' },
    ],
  },
  {
    group: 'Explanation',
    pages: [
      { title: 'Inside a Live Conversation', url: '/explanation/inside-a-live-conversation/' },
      { title: 'Platform Architecture', url: '/explanation/architecture/' },
    ],
  },
  {
    group: 'Reference',
    pages: [
      { title: 'SDK Reference', url: '/reference/sdk-reference/' },
      { title: 'API Reference', url: '/reference/api-reference/' },
      { title: 'Architecture Reference', url: '/reference/architecture-reference/' },
      { title: 'Wire Protocol', url: '/reference/wire-protocol/' },
      { title: 'GenUI Reference', url: '/reference/genui-reference/' },
      { title: 'Use-Case Catalog', url: '/reference/use-cases/' },
      { title: 'Security', url: '/reference/security/' },
    ],
  },
];

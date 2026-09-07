/**
 * The one place this site pins the SDK version it loads from jsDelivr.
 * connect.js and site-nav.js import from here, so they can never drift apart.
 *
 * Keep in sync with: src/index.md (quick-start jsDelivr pin, checked by
 * scripts/check-sdk-pin-sync.mjs) and docs-site-avatar/scripts/fetch-sdk.mjs
 * (DEFAULT_TAG, hand-synced).
 */
export const SDK_TAG = 'v1.18.0';
export const SDK_BASE = `https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@${SDK_TAG}`;

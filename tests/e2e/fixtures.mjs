import { test as base, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every spec imports `test` from here instead of '@playwright/test'. The auto
// fixture answers the site's jsDelivr imports (connect.js, site-nav.js) from
// the pinned SDK checkout, so the suite never depends on CDN availability or
// on a freshly tagged release still filling jsDelivr's cache. The checkout is
// the sibling `../intelligent-agents-sdk` locally and `.sdk-checkout` in
// pages.yml (SDK_REPO_DIR), pinned to the tag src/assets/nova/sdk.js names.

export const SDK_DIR = process.env.SDK_REPO_DIR
  || fileURLToPath(new URL('../../../intelligent-agents-sdk/', import.meta.url));
const JSDELIVR = /^https:\/\/cdn\.jsdelivr\.net\/gh\/kaltura\/intelligent-agents-sdk@[^/]+\/(src\/.+)$/;
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

if (!existsSync(join(SDK_DIR, 'src', 'experience', 'index.js'))) {
  throw new Error(`tests/e2e: SDK checkout not found at ${SDK_DIR} (set SDK_REPO_DIR to a checkout at the pinned tag)`);
}

const SDK_SRC = resolve(SDK_DIR, 'src') + sep;

/** Map a jsDelivr `src/...` path to a file inside the checkout's src/, or null if it escapes it. */
export function sdkFileFor(rel) {
  const file = resolve(SDK_DIR, decodeURIComponent(rel));
  return file.startsWith(SDK_SRC) ? file : null;
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(JSDELIVR, (route) => {
      const rel = route.request().url().match(JSDELIVR)[1];
      const file = sdkFileFor(rel);
      if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: `not in SDK checkout: ${rel}` });
      return route.fulfill({ status: 200, contentType: MIME[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    });
    await use(page);
  },
});

export { expect };

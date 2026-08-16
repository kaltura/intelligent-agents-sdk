#!/usr/bin/env node
// Fails the build if this repo's two SDK version pins drift apart:
// src/assets/nova/connect.js's SDK_TAG constant, and the jsDelivr tag
// hardcoded into src/index.md's quick-start code sample. A third pin lives
// in the separate docs-site-avatar repo (scripts/fetch-sdk.mjs's
// DEFAULT_TAG) — cross-repo automation isn't wired here; keep that one in
// sync by hand per the comments at each of these two sites.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const connectJsPath = `${repoRoot}src/assets/nova/connect.js`;
const indexMdPath = `${repoRoot}src/index.md`;

const connectJs = readFileSync(connectJsPath, 'utf8');
const indexMd = readFileSync(indexMdPath, 'utf8');

const connectMatch = connectJs.match(/const SDK_TAG = '([^']+)';/);
if (!connectMatch) {
  console.error(`check-sdk-pin-sync: could not find SDK_TAG constant in ${connectJsPath}`);
  process.exit(1);
}

const indexMatch = indexMd.match(/intelligent-agents-sdk@([^/]+)\/src\/experience\/index\.js/);
if (!indexMatch) {
  console.error(`check-sdk-pin-sync: could not find jsDelivr SDK pin in ${indexMdPath}`);
  process.exit(1);
}

const connectTag = connectMatch[1];
const indexTag = indexMatch[1];

if (connectTag !== indexTag) {
  console.error(
    `check-sdk-pin-sync: SDK version pins have drifted apart\n` +
    `  ${connectJsPath} SDK_TAG = '${connectTag}'\n` +
    `  ${indexMdPath} quick-start pin = '${indexTag}'\n` +
    `Bump whichever one is stale so both match, then re-run.`
  );
  process.exit(1);
}

console.log(`check-sdk-pin-sync: OK — both pinned to ${connectTag}`);

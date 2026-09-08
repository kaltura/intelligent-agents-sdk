#!/usr/bin/env node
/**
 * Distribution check for a released tag on the jsDelivr GitHub CDN.
 *
 * The SDK ships as raw files served by jsDelivr straight from a git tag, so the
 * "package" is whatever the CDN returns. This script proves that, for one tag:
 *
 *   1. the CDN serves every file under src/ at @TAG, byte-identical to git
 *      (HTTP 200, JavaScript content-type, sha256 match);
 *   2. the range refs consumers use (@latest, @MAJOR, @MAJOR.MINOR) resolve to
 *      this tag and serve the same bytes, polling until jsDelivr's resolver
 *      catches up or a deadline passes;
 *   3. every package.json export and every test/fakes file is reachable;
 *   4. the previous tag still serves its exports (pinned consumers keep working);
 *   5. a real headless Chromium can `import()` every browser export at @TAG and
 *      @latest with the same export names, the noise-suppressor AudioWorklet
 *      loads through a blob URL, and KalturaAvatarSession constructs.
 *
 * No retries on content checks: a wrong byte is a failure, not a flake. Only the
 * resolver / edge-cache catch-up for range refs is polled, with a hard deadline.
 *
 * Usage:
 *   npm run verify:distribution -- v1.19.0
 *   npm run verify:distribution -- v1.19.0 --no-browser
 *
 * Env:
 *   DIST_WAIT_SECONDS   max wait for @latest to reach the tag (default 600)
 *   DIST_REPO           GitHub repo slug (default kaltura/intelligent-agents-sdk)
 *
 * Exit code 0 only when every check passes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = process.env.DIST_REPO || 'kaltura/intelligent-agents-sdk';
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}`;
const RESOLVER = `https://data.jsdelivr.com/v1/packages/gh/${REPO}/resolved`;
const waitSeconds = Number(process.env.DIST_WAIT_SECONDS || 600);
if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  console.error(`DIST_WAIT_SECONDS must be a positive number of seconds, got "${process.env.DIST_WAIT_SECONDS}"`);
  process.exit(2);
}
const WAIT_MS = waitSeconds * 1000;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const withBrowser = !args.includes('--no-browser');
const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
if (!tag) {
  console.error('usage: verify-distribution.mjs vX.Y.Z [--no-browser]');
  process.exit(2);
}
const version = tag.slice(1);
const [major, minor] = version.split('.');

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const section = (title) => console.log(`\n== ${title}`);

// ---------------------------------------------------------------------------
// git helpers (the tag must exist locally: CI checks out with fetch-depth 0)
// ---------------------------------------------------------------------------
function git(...argv) {
  return execFileSync('git', argv, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitText(...argv) {
  return git(...argv).toString('utf8');
}
const shaCache = new Map();
function gitSha(ref, path) {
  const key = `${ref}:${path}`;
  if (!shaCache.has(key)) shaCache.set(key, createHash('sha256').update(git('show', key)).digest('hex'));
  return shaCache.get(key);
}
try {
  gitText('rev-parse', '--verify', `${tag}^{commit}`);
} catch {
  console.error(`tag ${tag} is not in this checkout. Run: git fetch origin tag ${tag}`);
  process.exit(2);
}

const srcFiles = gitText('ls-tree', '-r', '--name-only', tag, '--', 'src').trim().split('\n').filter(Boolean);
const fakeFiles = gitText('ls-tree', '-r', '--name-only', tag, '--', 'test/fakes').trim().split('\n').filter(Boolean);
const pkgAtTag = JSON.parse(gitText('show', `${tag}:package.json`));
const exportPaths = Object.values(pkgAtTag.exports)
  .map((v) => (typeof v === 'string' ? v : v.import || v.default))
  .filter((v) => v && !v.includes('*'))
  .map((v) => v.replace(/^\.\//, ''));
const previousTag = gitText('tag', '--sort=-v:refname', '--list', 'v*.*.*')
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .find((t) => t !== tag && compareSemver(t, tag) < 0) || null;

function compareSemver(a, b) {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

if (pkgAtTag.version !== version) {
  console.error(`package.json at ${tag} says ${pkgAtTag.version}, tag says ${version}`);
  process.exit(2);
}

console.log(`Distribution check for ${tag} (${srcFiles.length} src files, ${exportPaths.length} exports, ${fakeFiles.length} test/fakes files, previous tag ${previousTag || 'none'})`);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
// The one raw network call in this script. It must see the CDN exactly as a
// browser does: no retry, no backoff, no size budget, so a wrong byte or a
// stale edge is reported, not smoothed over. Every URL is built here from the
// fixed jsDelivr hosts and a git path; nothing comes from caller input.
async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } }); // nosemgrep: scripts.harness.no-raw-fetch-bypass
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type') || '', body };
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolvedVersion(specifier) {
  const { status, body } = await fetchBytes(`${RESOLVER}?specifier=${encodeURIComponent(specifier)}`);
  if (status !== 200) return null;
  try { return JSON.parse(body.toString('utf8')).version || null; } catch { return null; }
}

async function cdnPackageVersion(ref) {
  const { status, body } = await fetchBytes(`${CDN}@${ref}/package.json`);
  if (status !== 200) return null;
  try { return JSON.parse(body.toString('utf8')).version; } catch { return null; }
}

/** Every file in `paths` at `ref`: 200, JS content-type for .js, sha256 == git@tag. */
async function checkFilesAgainstGit(ref, paths) {
  const bad = [];
  await pool(paths, async (path) => {
    const url = `${CDN}@${ref}/${path}`;
    let r;
    try { r = await fetchBytes(url); } catch (e) { bad.push(`${path}: ${e.message}`); return; }
    const problems = [];
    if (r.status !== 200) problems.push(`HTTP ${r.status}`);
    if (/\.(m?js)$/.test(path) && !/javascript/i.test(r.contentType)) problems.push(`content-type ${r.contentType || 'missing'}`);
    if (r.status === 200) {
      const got = createHash('sha256').update(r.body).digest('hex');
      if (got !== gitSha(tag, path)) problems.push('sha256 mismatch');
    }
    if (problems.length) bad.push(`${path}: ${problems.join(', ')}`);
  });
  if (bad.length) {
    for (const b of bad.slice(0, 20)) fail(`@${ref} ${b}`);
    if (bad.length > 20) fail(`@${ref} ... and ${bad.length - 20} more`);
  } else {
    pass(`@${ref}: ${paths.length}/${paths.length} files are HTTP 200 and byte-identical to git ${tag} (.js served as JavaScript)`);
  }
  return bad.length === 0;
}

async function checkReachable(ref, paths, label) {
  const bad = [];
  await pool(paths, async (path) => {
    try {
      const { status } = await fetchBytes(`${CDN}@${ref}/${path}`);
      if (status !== 200) bad.push(`${path}: HTTP ${status}`);
    } catch (e) { bad.push(`${path}: ${e.message}`); }
  });
  if (bad.length) for (const b of bad) fail(`@${ref} ${b}`);
  else pass(`@${ref}: ${paths.length}/${paths.length} ${label} reachable`);
}

// ---------------------------------------------------------------------------
// 1. the tag itself
// ---------------------------------------------------------------------------
section(`1. @${tag}: package.json version and every src/ file`);
{
  const v = await cdnPackageVersion(tag);
  if (v === version) pass(`package.json on CDN is ${v}`);
  else fail(`package.json on CDN is ${v}, expected ${version}`);
  await checkFilesAgainstGit(tag, srcFiles);
}

// ---------------------------------------------------------------------------
// 2. range refs resolve to this tag and serve its bytes
// ---------------------------------------------------------------------------
section(`2. range refs resolve to ${version}: @latest, @${major}, @${major}.${minor}`);
const rangeRefs = ['latest', major, `${major}.${minor}`];
{
  // Wait for jsDelivr's resolver and the edge cache for package.json to agree
  // on the new tag. Range refs are cached up to 12 h, but a fresh tag usually
  // propagates within minutes. Hard deadline, then fail.
  const deadline = Date.now() + WAIT_MS;
  const ready = new Set();
  let attempt = 0;
  while (ready.size < rangeRefs.length && Date.now() < deadline) {
    attempt++;
    for (const ref of rangeRefs) {
      if (ready.has(ref)) continue;
      const [resolved, served] = await Promise.all([resolvedVersion(ref), cdnPackageVersion(ref)]);
      if (resolved === version && served === version) {
        ready.add(ref);
        pass(`@${ref} resolves to ${resolved} and serves package.json ${served} (attempt ${attempt})`);
      } else if (attempt === 1 || attempt % 6 === 0) {
        console.log(`  … @${ref} resolver=${resolved} served=${served}, waiting (${Math.round((deadline - Date.now()) / 1000)}s left)`);
      }
    }
    if (ready.size < rangeRefs.length) await sleep(10_000);
  }
  for (const ref of rangeRefs) {
    if (!ready.has(ref)) fail(`@${ref} did not reach ${version} within ${WAIT_MS / 1000}s`);
  }
  // Resolver agreement is not enough: file content is cached per URL. Check bytes.
  for (const ref of rangeRefs) {
    if (ready.has(ref)) await checkFilesAgainstGit(ref, srcFiles);
  }
}

// ---------------------------------------------------------------------------
// 3. exports and test/fakes reachable at the tag
// ---------------------------------------------------------------------------
section(`3. @${tag}: package.json exports and test/fakes`);
await checkReachable(tag, exportPaths, 'export entry points');
if (fakeFiles.length) await checkReachable(tag, fakeFiles, 'test/fakes files');
else fail('no test/fakes files at the tag');

// ---------------------------------------------------------------------------
// 4. previous tag still served
// ---------------------------------------------------------------------------
section(`4. previous tag ${previousTag || '(none)'} still serves its exports`);
if (previousTag) {
  const prevPkg = JSON.parse(gitText('show', `${previousTag}:package.json`));
  const prevExports = Object.values(prevPkg.exports)
    .map((v) => (typeof v === 'string' ? v : v.import || v.default))
    .filter((v) => v && !v.includes('*'))
    .map((v) => v.replace(/^\.\//, ''));
  await checkReachable(previousTag, prevExports, 'export entry points');
  const v = await cdnPackageVersion(previousTag);
  if (v === previousTag.slice(1)) pass(`@${previousTag} package.json is still ${v}`);
  else fail(`@${previousTag} package.json is ${v}, expected ${previousTag.slice(1)}`);
} else {
  pass('no previous tag in this checkout, skipped');
}

// ---------------------------------------------------------------------------
// 5. real browser import of every export at @tag and @latest
// ---------------------------------------------------------------------------
section('5. headless Chromium: import every export at @tag and @latest, worklet + session smoke');
if (!withBrowser) {
  console.log('  skipped (--no-browser)');
} else {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    fail(`playwright is not installed (${e.message}); run npm ci && npx playwright install chromium`);
  }
  if (chromium) {
    const browser = await chromium.launch({
      args: [
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    try {
      const names = {};
      for (const ref of [tag, 'latest']) {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
        // A real https origin: module scripts and AudioWorklet need a secure context.
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async ({ base, entries }) => {
          const out = {};
          for (const entry of entries) {
            try {
              const mod = await import(`${base}/${entry}`);
              out[entry] = { ok: true, names: Object.keys(mod).sort() };
            } catch (err) {
              out[entry] = { ok: false, error: String(err) };
            }
          }
          return out;
        }, { base: `${CDN}@${ref}`, entries: exportPaths });
        names[ref] = result;
        for (const [entry, r] of Object.entries(result)) {
          if (r.ok && r.names.length > 0) pass(`@${ref} import ${entry}: ${r.names.length} exports`);
          else if (r.ok) fail(`@${ref} import ${entry}: module has no exports`);
          else fail(`@${ref} import ${entry}: ${r.error}`);
        }
        if (pageErrors.length) fail(`@${ref} page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
        await page.close();
      }
      // Same export names at @tag and @latest: proves @latest is this release.
      for (const entry of exportPaths) {
        const a = names[tag]?.[entry]?.names?.join(',');
        const b = names.latest?.[entry]?.names?.join(',');
        if (a && a === b) pass(`${entry}: export names identical at @${tag} and @latest`);
        else fail(`${entry}: export names differ between @${tag} and @latest`);
      }

      // Runtime smoke at @tag: worklet loads and processes a real MediaStream,
      // the session constructs with app-owned video + audio elements.
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
      const smoke = await page.evaluate(async (base) => {
        const out = {};
        try {
          const ns = await import(`${base}/src/experience/noise-suppressor.js`);
          const ctx = new AudioContext({ sampleRate: 48000 });
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          const processor = ns.createNoiseSuppressor({ audioContext: ctx });
          const res = await processor(mic);
          out.noiseSuppressor = {
            ok: res.stream instanceof MediaStream && typeof res.stop === 'function' && res.stream.getAudioTracks().length === 1,
            tracks: res.stream.getAudioTracks().length,
          };
          res.stop();
          mic.getTracks().forEach((t) => t.stop());
          await ctx.close();
        } catch (e) {
          out.noiseSuppressor = { ok: false, error: String(e) };
        }
        try {
          const ex = await import(`${base}/src/experience/index.js`);
          const videoEl = document.createElement('video');
          const audioEl = document.createElement('audio');
          const token = 'djJ8' + btoa('v2|123|geniegpcid:1222').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const session = new ex.KalturaAvatarSession({
            token,
            srsBaseUrl: 'https://srs.example',
            turnServerUrl: 'turn.avatar.us.kaltura.ai',
            videoEl,
            audioEl,
            socketFactory: () => ({ on() {}, emit() {}, disconnect() {} }),
          });
          // avatarStream is null before the first downlink track (documented contract).
          out.session = {
            ok: session.videoEl === videoEl && session.audioEl === audioEl && session.avatarStream === null
              && typeof session.setAudioEl === 'function' && typeof session.startPlayback === 'function',
            audioOutputMuted: session.audioOutputMuted,
            audioOutputVolume: session.audioOutputVolume,
          };
          session.disconnect();
        } catch (e) {
          out.session = { ok: false, error: String(e) };
        }
        return out;
      }, `${CDN}@${tag}`);
      await page.close();
      if (smoke.noiseSuppressor.ok) pass(`noise-suppressor worklet loads and returns a 1-track MediaStream at @${tag}`);
      else fail(`noise-suppressor smoke: ${smoke.noiseSuppressor.error || JSON.stringify(smoke.noiseSuppressor)}`);
      if (smoke.session.ok) pass(`KalturaAvatarSession constructs with videoEl + audioEl at @${tag} (muted=${smoke.session.audioOutputMuted}, volume=${smoke.session.audioOutputVolume})`);
      else fail(`KalturaAvatarSession smoke: ${smoke.session.error || JSON.stringify(smoke.session)}`);
      if (pageErrors.length) fail(`smoke page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    } finally {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures} failing check${failures === 1 ? '' : 's'})`} for ${tag}`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Live check of the documented numeric limits: pass at the limit, fail at limit + 1.
 * Real Kaltura API, no fakes, no mocks.
 *
 *   1  badge id            1 and 64 characters pass, 65 and empty fail; `.` and space fail, `_` `-` pass
 *   2  badge score         1,000,000 and -1,000,000 pass, 1,000,001 and -1,000,001 fail (also with `scoreAction: 'delta'`)
 *   3  insight setting key 1 and 64 characters pass, 65 fails; `.` and `-` pass, space and `:` fail
 *   4  cleanup             every rule and setting deleted, also on Ctrl+C or SIGTERM
 *
 * The 100-character voice name limit on `catalog.createVoice` has no live check here. The accepting side needs a
 * real voice clone, which burns provider quota. Its request shaping is covered by unit tests.
 *
 * Each rule is scoped to an agent id that does not exist, so it can never match a real conversation.
 * A rejection must be a 400 (`bad_request`). Any other failure fails the step.
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs.
 *
 * QA note: non-production targets such as nvq2 are for employees and certified partners only.
 */
import { resolveTarget, managementFor } from './lib/target.mjs';

const target = resolveTarget(process.env.TARGET ?? 'prod');
const kaltura = managementFor(target);
const tag = `sdk-live-${Date.now().toString(36)}`;
const NO_AGENT = '00000000-0000-4000-8000-000000000000';
/** @type {{rules:string[], settings:string[]}} */
const created = { rules: [], settings: [] };
/** @type {Array<[string, boolean]>} */
const results = [];
let admin;
let n = 0;
let stopping = 0; // exit code of the signal that stopped the run, 0 while running
/** @type {Promise<void>} */
let inflight = Promise.resolve();

const record = (label, ok, extra = '') => {
  results.push([label, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${extra}`}`);
};
const rep = (len, ch = 'a') => ch.repeat(len);

/** Run `create`; pass when the outcome matches `expectOk`. A rejection must be a 400. */
async function attempt(label, expectOk, create, collect) {
  if (stopping) return;
  let release;
  inflight = new Promise((resolve) => { release = resolve; });
  try {
    collect(await create());
    record(`${label} accepted`, expectOk);
  } catch (e) {
    record(`${label} rejected`, !expectOk && e.status === 400, `(status ${e.status}, ${e.code}: ${String(e.detail).slice(0, 100)})`);
  } finally {
    release();
  }
}

const badge = (label, b, expectOk) => attempt(`badge ${label}`, expectOk, () => {
  const i = ++n;
  return kaltura.lifecycle.create({
    name: `${tag} ${i}`, systemName: `${tag.replace(/-/g, '_')}_${i}`, eventType: 'analysis_updated', objectType: 'thread',
    eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: NO_AGENT }, { field: 'changed_keys', operator: 'has_all', value: ['K'] }],
    action: { actionType: 'createBadges', badges: [b] },
  }, admin);
}, (r) => created.rules.push(r.id));

const setting = (label, key, expectOk) => attempt(`insight key ${label}`, expectOk,
  () => kaltura.insightSettings.create({ key, title: `${tag} s`, prompt: 'x', valueType: 'string' }, admin),
  (r) => created.settings.push(r.id));

let cleanupP;
async function doCleanup() {
  if (!admin) return;
  for (const id of [...created.rules]) {
    await kaltura.lifecycle.delete(id, admin, { confirmPermanent: true }).catch((e) => console.log(`cleanup: rule ${id} not deleted (${e.code})`));
    created.rules.splice(created.rules.indexOf(id), 1);
  }
  for (const id of [...created.settings]) {
    await kaltura.insightSettings.delete(id, admin, { confirmPermanent: true }).catch((e) => console.log(`cleanup: setting ${id} not deleted (${e.code})`));
    created.settings.splice(created.settings.indexOf(id), 1);
  }
}
/** One shared run: a second call, or a second signal, waits for the delete in flight. */
const cleanup = () => (cleanupP ??= doCleanup());
let signals = 0;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    stopping ||= code;
    if (++signals >= 3) {
      // Escape hatch: tell the operator what is left, then leave without waiting.
      console.log(`cleanup abandoned. Still to delete: rules [${created.rules.join(', ')}], insight settings [${created.settings.join(', ')}]`);
      process.exit(stopping);
    }
    inflight.then(cleanup).finally(() => process.exit(stopping));
  });
}

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  await badge('id 1 char', { badgeId: 'a', type: 'boolean', score: 1 }, true);
  await badge('id 64 chars', { badgeId: rep(64), type: 'boolean', score: 1 }, true);
  await badge('id 65 chars', { badgeId: rep(65), type: 'boolean', score: 1 }, false);
  await badge('id empty', { badgeId: '', type: 'boolean', score: 1 }, false);
  await badge('id with _ and -', { badgeId: 'a_b-C9', type: 'boolean', score: 1 }, true);
  await badge('id with a dot', { badgeId: 'a.b', type: 'boolean', score: 1 }, false);
  await badge('id with a space', { badgeId: 'a b', type: 'boolean', score: 1 }, false);
  await badge('score 1000000', { badgeId: 'sa', type: 'boolean', score: 1000000 }, true);
  await badge('score -1000000', { badgeId: 'sb', type: 'boolean', score: -1000000 }, true);
  await badge('score 1000001', { badgeId: 'sc', type: 'boolean', score: 1000001 }, false);
  await badge('score -1000001', { badgeId: 'sd', type: 'boolean', score: -1000001 }, false);
  await badge('delta score 1000000', { badgeId: 'se', type: 'boolean', score: 1000000, scoreAction: 'delta' }, true);
  await badge('delta score 1000001', { badgeId: 'sf', type: 'boolean', score: 1000001, scoreAction: 'delta' }, false);
  await setting('1 char', 'a', true);
  await setting('64 chars', rep(64), true);
  await setting('65 chars', rep(65), false);
  await setting('with . and -', 'a.b_c-D9', true);
  await setting('with a space', 'a b', false);
  await setting('with a colon', 'a:b', false);
} finally {
  await cleanup();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${results.length - failed} of ${results.length} passed${stopping ? ' (interrupted)' : ''}`);
process.exit(stopping || (failed ? 1 : 0));

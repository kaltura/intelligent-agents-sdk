#!/usr/bin/env node
/**
 * Live verification of avatar emotions (Limited Availability).
 * Runs are for employees and certified partners only. See docs/contributor/limited-availability.md.
 *
 * Provisions a throwaway agent and runs the same sad-then-cheerful prompt:
 *
 *   trials   3 turns with `capabilities {avatar:'on', avatar_emotions:'on'}`.
 *            A trial passes with 2 or more distinct `metadata.emotion` labels over
 *            2 or more avatar segments. The run passes when at least 2 of 3 trials pass.
 *   control  1 turn with `avatar_emotions` off. No chunk may carry `metadata.emotion`, and the reply must not be empty.
 *   setting  `avatars.create`, `get` and `update` round-trip the `emotions` object
 *            on a throwaway avatar (omitted keys keep their value, `allowed: []` clears).
 *
 * Everything the run creates is deleted at the end, also on Ctrl-C.
 *
 * Usage
 *   TARGET=<name> node scripts/live-verify-emotions.mjs   # name of the Limited Availability environment
 *
 * Needs that environment's credentials in the environment or a .env file (see scripts/lib/target.mjs).
 * Not part of CI: CI has no credentials for that environment.
 */
import { Management } from '../src/management/index.js';
import { resolveTarget } from './lib/target.mjs';
import { Report, ensureAgent } from './live-verify-kickoff-shared.mjs';

const TRIALS = 3;
const NEED_PASSES = 2;
const PROMPT = 'Tell me a short sad story, then cheer me up.';
const RUN_TAG = Math.random().toString(36).slice(2, 8);

if (!process.env.TARGET) {
  console.error('TARGET is not set. Set it to the name of the Limited Availability environment, for example: TARGET=<name> node scripts/live-verify-emotions.mjs');
  process.exit(1);
}
const target = resolveTarget(process.env.TARGET);
const kaltura = new Management(target);
const report = new Report({ runId: `emotions-${target.name}-${Date.now()}`, target: target.name });

/** @type {{agent?: Awaited<ReturnType<typeof ensureAgent>>, avatarId?: string}} */
const made = {};
let ks = /** @type {any} */ (null);

async function cleanup() {
  if (made.avatarId) {
    try { await kaltura.avatars.delete(made.avatarId, ks, { confirmPermanent: true }); made.avatarId = undefined; } catch (err) { console.warn(`cleanup: avatar delete failed: ${err?.message || err}`); }
  }
  if (made.agent) { await made.agent.cleanup(); made.agent = undefined; }
}
process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });

/**
 * One turn. Returns the avatar segment count and the emotion labels in order.
 * @param {string} convKs @param {Record<string,string>} capabilities
 */
async function turn(convKs, capabilities) {
  let avatarSegments = 0;
  /** @type {string[]} */ const labels = [];
  let anyMetadataEmotion = 0;
  let spokenChars = 0;
  /** @type {string[]} */ const types = [];
  for await (const seg of kaltura.conversations.stream({ userMessage: PROMPT, capabilities }, convKs)) {
    types.push(String(seg.type));
    if ((seg.type === 'avatar' || seg.type === 'text') && typeof seg.content === 'string') spokenChars += seg.content.length;
    if (seg.metadata && 'emotion' in seg.metadata) anyMetadataEmotion++;
    if (seg.type === 'avatar' && seg.segmentStart) {
      avatarSegments++;
      if (seg.metadata?.emotion) labels.push(seg.metadata.emotion);
    }
  }
  return { avatarSegments, labels, anyMetadataEmotion, spokenChars, types: [...new Set(types)].join(',') };
}

async function emotionsSetting() {
  const voice = (await kaltura.catalog.list(ks, { type: 'Voice', pageSize: 1 }).all())[0];
  const visual = (await kaltura.catalog.list(ks, { type: 'Visual', pageSize: 1 }).all())[0];
  if (!voice || !visual) { report.check('setting: catalog has a voice and a visual', false); return; }
  const created = await kaltura.avatars.create({
    name: `sdk-live-${RUN_TAG}`, voice: { id: voice.itemId }, visual: { id: visual.itemId },
    emotions: { enabled: true, intensity: 0.5, allowed: ['happy', 'sad'] },
  }, ks);
  made.avatarId = created.id;
  const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
  const got = await kaltura.avatars.get(created.id, ks);
  report.check('setting: create then get returns the object', same(got.emotions, { enabled: true, intensity: 0.5, allowed: ['happy', 'sad'] }), got.emotions);
  const upd = await kaltura.avatars.update({ id: created.id, emotions: { intensity: 0.8 } }, ks);
  report.check('setting: update keeps omitted keys', same(upd.emotions, { enabled: true, intensity: 0.8, allowed: ['happy', 'sad'] }), upd.emotions);
  const cleared = await kaltura.avatars.update({ id: created.id, emotions: { allowed: [] } }, ks);
  report.check('setting: allowed [] clears the list', same(cleared.emotions?.allowed, []), cleared.emotions);
  await kaltura.avatars.delete(created.id, ks, { confirmPermanent: true });
  made.avatarId = undefined;
  const gone = await kaltura.avatars.get(created.id, ks).then(() => false, () => true);
  report.check('setting: avatar deleted', gone);
}

let failed = true;
try {
  ks = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  made.agent = await ensureAgent(kaltura, ks.ks, { openingPhrase: 'Hello there.' });
  const conv = await kaltura.sessions.createConversationToken({ configId: made.agent.configId });

  let passes = 0;
  for (let i = 1; i <= TRIALS; i++) {
    const r = await turn(conv.ks, { avatar: 'on', avatar_emotions: 'on' });
    const distinct = new Set(r.labels);
    const ok = distinct.size >= 2 && r.avatarSegments >= 2;
    if (ok) passes++;
    report.note(`trial ${i}`, { ok, avatarSegments: r.avatarSegments, labels: r.labels, types: r.types });
  }
  report.check(`trials: at least ${NEED_PASSES} of ${TRIALS} show 2+ distinct labels over 2+ avatar segments`, passes >= NEED_PASSES, { passes });

  const control = await turn(conv.ks, { avatar: 'on', avatar_emotions: 'off' });
  report.check('control: avatar_emotions off shows no metadata.emotion (and the reply was not empty)', control.anyMetadataEmotion === 0 && control.spokenChars > 0, control);

  await emotionsSetting();
  failed = report.failed;
} catch (err) {
  report.check('run completed without an error', false, { code: /** @type {any} */ (err)?.code, message: /** @type {any} */ (err)?.message });
} finally {
  await cleanup();
}
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);

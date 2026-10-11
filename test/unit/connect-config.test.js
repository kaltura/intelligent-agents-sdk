// cfg.reconnectionDelay(Max) reach the socket factory. cfg.timeouts merges over the defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** @param {object} extra */
function build(extra = {}) {
  FakeRTCPeerConnection.reset();
  /** @type {any[]} */ const seen = [];
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl(), rtcConstructor: FakeRTCPeerConnection, fetch: fakeWhepFetch([{}]),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    socketFactory: (_url, opts) => { seen.push(opts); const s = new FakeSocket(); scriptHappyPath(s); return s; },
    ...extra,
  });
  return { session, seen };
}

test('socket factory gets the default reconnection delays', async () => {
  const { session, seen } = build();
  await session.connect();
  assert.equal(seen[0].reconnectionDelay, 250);
  assert.equal(seen[0].reconnectionDelayMax, 2000);
  session.disconnect();
});

test('cfg.reconnectionDelay and reconnectionDelayMax override the defaults', async () => {
  const { session, seen } = build({ reconnectionDelay: 100, reconnectionDelayMax: 900 });
  await session.connect();
  assert.equal(seen[0].reconnectionDelay, 100);
  assert.equal(seen[0].reconnectionDelayMax, 900);
  session.disconnect();
});

test('cfg.timeouts merges over the defaults: one key changes, the rest stay', () => {
  const { session } = build({ timeouts: { firstFrame: 1234 } });
  const t = /** @type {any} */ (session)._timeouts;
  assert.equal(t.firstFrame, 1234);
  assert.equal(t.overall, 30000);
  assert.equal(t.joinComplete, 20000);
  assert.equal(t.prepareIdle, 60000);
});

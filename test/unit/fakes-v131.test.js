import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRTCPeerConnection, FakeVideoEl } from '../fakes/rtc.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { fakeWhepFetch } from '../fakes/whep.js';

test('FakeRTCPeerConnection: connection state helper fires the handler; close() is silent', () => {
  const pc = new FakeRTCPeerConnection();
  let fired = 0;
  pc.onconnectionstatechange = () => { fired += 1; };
  assert.equal(pc.connectionState, 'new');
  pc.setConnectionState('failed');
  assert.equal(pc.connectionState, 'failed');
  assert.equal(fired, 1);
  pc.close();
  assert.equal(pc.connectionState, 'closed');
  assert.equal(pc.signalingState, 'closed');
  assert.equal(fired, 1, 'a local close fires no event, like a real peer');
});

test('FakeRTCPeerConnection: setInboundVideo shapes the getStats report', async () => {
  const pc = new FakeRTCPeerConnection();
  pc.setInboundVideo({ bytesReceived: 100, framesDecoded: 3, packetsReceived: 9 });
  const report = [...(await pc.getStats()).values()];
  assert.equal(report.length, 1);
  assert.deepEqual(
    { type: report[0].type, kind: report[0].kind, bytes: report[0].bytesReceived, frames: report[0].framesDecoded, packets: report[0].packetsReceived },
    { type: 'inbound-rtp', kind: 'video', bytes: 100, frames: 3, packets: 9 },
  );
});

test('FakeVideoEl: fireFrame runs pending rVFC callbacks once and sets the size', () => {
  const el = new FakeVideoEl();
  const seen = [];
  el.requestVideoFrameCallback((now, meta) => seen.push(meta));
  const cancelled = el.requestVideoFrameCallback(() => seen.push('cancelled'));
  el.cancelVideoFrameCallback(cancelled);
  el.fireFrame(1280, 720);
  assert.equal(el.videoWidth, 1280);
  assert.deepEqual(seen, [{ width: 1280, height: 720, presentedFrames: 1 }]);
  el.fireFrame();
  assert.equal(seen.length, 1, 'callbacks are one-shot');
});

test('FakeVideoEl: rvfc:false leaves the API out', () => {
  const el = new FakeVideoEl({ rvfc: false });
  assert.equal(el.requestVideoFrameCallback, undefined);
  assert.equal(el.cancelVideoFrameCallback, undefined);
});

test('scriptHappyPath: webrtcUrls gives one URL per stvNewSession and the last repeats', async () => {
  const socket = new FakeSocket();
  scriptHappyPath(socket, { webrtcUrls: ['https://a.example/whep', 'https://b.example/whep'], delayStvReplyMs: 0 });
  /** @type {any[]} */ const replies = [];
  let resuming = 0;
  socket.on('stvNewSession', (p) => replies.push(p));
  socket.on('resumingSession', () => { resuming += 1; });
  for (let i = 0; i < 3; i++) {
    socket.emit('stvNewSession', {});
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(replies.map((r) => r.webrtc_url), ['https://a.example/whep', 'https://b.example/whep', 'https://b.example/whep']);
  assert.deepEqual(replies.map((r) => r.session_id), ['sess-123', 'sess-2', 'sess-3']);
  assert.equal(resuming, 2, 'the second and third replies are preceded by resumingSession');
});

test('scriptHappyPath: resumingOnRecreate:false drops resumingSession', async () => {
  const socket = new FakeSocket();
  scriptHappyPath(socket, { resumingOnRecreate: false });
  let resuming = 0;
  socket.on('resumingSession', () => { resuming += 1; });
  socket.emit('stvNewSession', {});
  await new Promise((r) => setTimeout(r, 5));
  socket.emit('stvNewSession', {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(resuming, 0);
});

test('scriptHappyPath: delayStvReplyMs holds the reply (fake timers)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new FakeSocket();
  scriptHappyPath(socket, { delayStvReplyMs: 7000 });
  let replied = 0;
  socket.on('stvNewSession', () => { replied += 1; });
  socket.emit('stvNewSession', {});
  t.mock.timers.tick(6999);
  assert.equal(replied, 0);
  t.mock.timers.tick(1);
  assert.equal(replied, 1);
});

test('fakeWhepFetch: steps run in order, the last repeats, and POSTs and DELETEs are recorded', async () => {
  const f = fakeWhepFetch([{ status: 503 }, { status: 201, location: '/viewer/v1' }]);
  const url = 'https://srs.example/rtc/v1/whep/?stream=s';
  const a = await f(url, { method: 'POST', body: 'offer' });
  const b = await f(url, { method: 'POST', body: 'offer' });
  const c = await f(url, { method: 'POST', body: 'offer' });
  assert.deepEqual([a.status, b.status, c.status], [503, 201, 201]);
  assert.equal(b.headers.get('Location'), '/viewer/v1');
  assert.equal(await b.text(), 'v=0\r\nfake-answer\r\n');
  const d = await f('https://srs.example/rtc/v1/whep/viewer/v1', { method: 'DELETE', keepalive: true });
  assert.equal(d.status, 200);
  assert.equal(f.posts.length, 3);
  assert.equal(f.deletes.length, 1);
  assert.equal(f.deletes[0].keepalive, true);
});

test('fakeWhepFetch: reset rejects with a network TypeError', async () => {
  const f = fakeWhepFetch([{ reset: true }]);
  await assert.rejects(f('https://srs.example/rtc/v1/whep/', { method: 'POST' }), (e) => e instanceof TypeError);
});

test('fakeWhepFetch: delayMs waits on a mockable timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fakeWhepFetch([{ delayMs: 5000 }]);
  let status = 0;
  const p = f('https://srs.example/rtc/v1/whep/', { method: 'POST' }).then((r) => { status = r.status; });
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(status, 0);
  t.mock.timers.tick(1);
  await p;
  assert.equal(status, 201);
});

test('fakeWhepFetch: hang ends only on abort, and the abort is recorded', async () => {
  const f = fakeWhepFetch([{ hang: true }]);
  const ac = new AbortController();
  const p = f('https://srs.example/rtc/v1/whep/', { method: 'POST', signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(f.calls[0].aborted, true);
});

test('fakeWhepFetch: an already-aborted signal rejects at once', async () => {
  const f = fakeWhepFetch([{}]);
  await assert.rejects(f('https://srs.example/rtc/v1/whep/', { method: 'POST', signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
});

test('fakeWhepFetch: non-WHEP URLs go to the fallback', async () => {
  const fallback = mock.fn(async () => ({ ok: true, status: 200 }));
  const f = fakeWhepFetch([{}], { fallback });
  const r = await f('https://api.example/thing');
  assert.equal(r.status, 200);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(f.calls.length, 0);
});

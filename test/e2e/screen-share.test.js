/**
 * startScreenShare() / stopScreenShare(): the SDK owns the picker, the capture
 * loop and the three socket events (screenShareStarted, userScreenSharePendingImage,
 * userScreenShareShot, screenShareStopped), so an app never touches the socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptHappyPath } from '../fakes/socket.js';
import { newAvatarSession } from '../fakes/avatar-session.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeDisplay() {
  const stopped = [];
  const listeners = {};
  const track = { kind: 'video', stop: () => stopped.push('track'), addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const calls = [];
  return { stream, stopped, end: () => listeners.ended?.(), calls, getDisplayMedia: async (c) => { calls.push(c); return stream; } };
}

function fakeCapture() {
  const state = { grabs: 0, closed: 0, fail: false };
  const factory = async () => ({
    grab: async () => { state.grabs += 1; if (state.fail) throw new Error('boom'); return new Uint8Array([state.grabs]).buffer; },
    close: () => { state.closed += 1; },
  });
  return { state, factory };
}

async function connected({ enabled = true, display = fakeDisplay(), capture = fakeCapture() } = {}) {
  const { session, socket } = newAvatarSession({ cfg: { getDisplayMedia: display.getDisplayMedia, screenCapture: capture.factory } });
  scriptHappyPath(socket, { clientConfig: { languageCode: 'en', interruptionsEnabled: true, isScreenShareEnabled: enabled } });
  await session.connect();
  return { session, socket, display, capture };
}

test('start sends the started and pending events, then a still every interval; stop sends stopped', async () => {
  const { session, socket, display, capture } = await connected();
  const changes = [];
  session.on('screenShareChanged', (e) => changes.push(e.active));
  await session.startScreenShare({ intervalMs: 20 });
  assert.equal(session.screenSharing, true);
  assert.deepEqual(display.calls[0].audio, false);
  assert.ok(socket.didEmit('screenShareStarted'));
  assert.ok(socket.didEmit('userScreenSharePendingImage'));
  await tick(70);
  assert.ok(socket.emitsOf('userScreenShareShot').length >= 2, 'a still arrives every interval');
  assert.ok(socket.emitsOf('userScreenShareShot')[0].data instanceof ArrayBuffer);
  session.stopScreenShare();
  assert.equal(session.screenSharing, false);
  assert.ok(socket.didEmit('screenShareStopped'));
  assert.deepEqual(display.stopped, ['track'], 'the SDK stops tracks it requested');
  assert.equal(capture.state.closed, 1);
  const sent = socket.emitsOf('userScreenShareShot').length;
  await tick(50);
  assert.equal(socket.emitsOf('userScreenShareShot').length, sent, 'no still after stop');
  assert.deepEqual(changes, [true, false]);
  session.disconnect();
});

test('the browser ending the share stops it and tells the server', async () => {
  const { session, socket, display } = await connected();
  await session.startScreenShare({ intervalMs: 1000 });
  display.end();
  assert.equal(session.screenSharing, false);
  assert.ok(socket.didEmit('screenShareStopped'));
  session.disconnect();
});

test('disconnect() ends a running share and releases the stream', async () => {
  const { session, display, capture } = await connected();
  await session.startScreenShare({ intervalMs: 1000 });
  session.disconnect();
  assert.equal(session.screenSharing, false);
  assert.deepEqual(display.stopped, ['track']);
  assert.equal(capture.state.closed, 1);
});

test('a second start is a no-op; a stream you pass in is not stopped by the SDK', async () => {
  const display = fakeDisplay();
  const { session } = await connected({ display });
  await session.startScreenShare({ stream: display.stream, intervalMs: 1000 });
  await session.startScreenShare({ stream: display.stream });
  assert.equal(display.calls.length, 0, 'no picker when a stream is passed');
  session.stopScreenShare();
  assert.deepEqual(display.stopped, [], 'the app owns a stream it passed in');
  session.disconnect();
});

test('guards: capability off, not connected, cancelled picker, missing getDisplayMedia', async () => {
  const off = await connected({ enabled: false });
  await assert.rejects(() => off.session.startScreenShare(), (e) => e.code === 'capability_disabled');
  off.session.disconnect();

  const { session } = newAvatarSession();
  await assert.rejects(() => session.startScreenShare(), (e) => e.code === 'invalid_state');

  const denied = async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; };
  const a = newAvatarSession({ cfg: { getDisplayMedia: denied } });
  scriptHappyPath(a.socket, { clientConfig: { languageCode: 'en', isScreenShareEnabled: true } });
  await a.session.connect();
  await assert.rejects(() => a.session.startScreenShare(), (e) => e.code === 'screen_share_denied');
  assert.equal(a.session.state, 'connected', 'a cancelled picker does not end the session');
  assert.equal(a.session.screenSharing, false);
  a.session.disconnect();

  const b = newAvatarSession();
  scriptHappyPath(b.socket, { clientConfig: { languageCode: 'en', isScreenShareEnabled: true } });
  await b.session.connect();
  await assert.rejects(() => b.session.startScreenShare(), (e) => e.code === 'screen_share_unsupported');
  b.session.disconnect();
});

test('a failed frame grab is a warning and the loop keeps going', async () => {
  const capture = fakeCapture();
  capture.state.fail = true;
  const { session } = await connected({ capture });
  const warnings = [];
  session.on('warning', (w) => warnings.push(w.code));
  await session.startScreenShare({ intervalMs: 15 });
  await tick(60);
  assert.ok(warnings.includes('screen_share_capture_failed'));
  assert.ok(capture.state.grabs >= 2, 'it retries on the next interval');
  session.disconnect();
});

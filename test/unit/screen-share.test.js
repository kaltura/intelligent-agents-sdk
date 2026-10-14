// The frame grabber and error mapping behind startScreenShare(), with a fake document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStillCapturer, screenShareError, SCREEN_SHARE_DEFAULTS } from '../../src/experience/screen-share.js';

function fakeDoc({ width = 3000, height = 1500, blob = true } = {}) {
  const drawn = [];
  const video = { videoWidth: width, videoHeight: height, play: async () => {}, pause() { this.paused = true; } };
  const canvas = {
    getContext: () => ({ drawImage: (...a) => drawn.push(a.slice(1)) }),
    toBlob: (cb, type, q) => cb(blob ? { type, q, arrayBuffer: async () => new ArrayBuffer(4) } : null),
  };
  return { video, canvas, drawn, createElement: (tag) => (tag === 'video' ? video : canvas) };
}

test('grab scales to maxWidth and returns a JPEG ArrayBuffer', async () => {
  const doc = fakeDoc();
  const cap = await createStillCapturer({ id: 's' }, { maxWidth: 1500, quality: 0.5 }, doc);
  assert.equal(doc.video.srcObject.id, 's');
  const buf = await cap.grab();
  assert.ok(buf instanceof ArrayBuffer);
  assert.deepEqual([doc.canvas.width, doc.canvas.height], [1500, 750]);
  assert.deepEqual(doc.drawn[0], [0, 0, 1500, 750]);
  cap.close();
  assert.equal(doc.video.paused, true);
  assert.equal(doc.video.srcObject, null);
});

test('a small screen is not scaled up', async () => {
  const doc = fakeDoc({ width: 800, height: 600 });
  const cap = await createStillCapturer({}, { maxWidth: 1500, quality: 0.5 }, doc);
  await cap.grab();
  assert.deepEqual([doc.canvas.width, doc.canvas.height], [800, 600]);
});

test('grab rejects with screen_share_capture_failed before the first frame and when encoding fails', async () => {
  const empty = await createStillCapturer({}, SCREEN_SHARE_DEFAULTS, fakeDoc({ width: 0, height: 0 }));
  await assert.rejects(() => empty.grab(), (e) => e.code === 'screen_share_capture_failed');
  const noBlob = await createStillCapturer({}, SCREEN_SHARE_DEFAULTS, fakeDoc({ blob: false }));
  await assert.rejects(() => noBlob.grab(), (e) => e.code === 'screen_share_capture_failed');
});

test('without a document the capturer is unsupported; picker errors map to distinct codes', async () => {
  await assert.rejects(() => createStillCapturer({}, SCREEN_SHARE_DEFAULTS, null), (e) => e.code === 'screen_share_unsupported');
  assert.equal(screenShareError(Object.assign(new Error('x'), { name: 'NotAllowedError' })).code, 'screen_share_denied');
  assert.equal(screenShareError(Object.assign(new Error('x'), { name: 'NotReadableError' })).code, 'screen_share_failed');
});

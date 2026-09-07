/**
 * `assertInvariants(media)` — the six stream invariants an `AvatarMedia` instance must hold
 * after every operation (SDK_CONSTITUTION § M-1 companion, plan §5.4.5). Reads private
 * fields on purpose: the invariants are about the internal streams, not the public API.
 *
 *  1. every track in V or A is in C
 *  2. no ended track in any stream
 *  3. V and A share no track
 *  4. with a sink bound, the audio track is in exactly one of V / A
 *  5. each bound element's srcObject is its stream, or null after teardown
 *  6. C holds at most one track per kind
 */
import assert from 'node:assert/strict';

/** @param {import('../../../src/experience/avatar-media.js').AvatarMedia} media @param {string} [label] */
export function assertInvariants(media, label = '') {
  const tag = label ? `[${label}] ` : '';
  const c = media._c, v = media._v, a = media._a;
  const tracks = (s) => (s ? s.getTracks() : []);

  if (!c) {
    assert.equal(v, null, `${tag}inv-5: V must be null when C is null`);
    assert.equal(a, null, `${tag}inv-5: A must be null when C is null`);
    if (media._videoEl && 'srcObject' in media._videoEl) assert.equal(media._videoEl.srcObject, null, `${tag}inv-5: videoEl.srcObject null after teardown`);
    if (media._audioEl && 'srcObject' in media._audioEl) assert.equal(media._audioEl.srcObject, null, `${tag}inv-5: audioEl.srcObject null after teardown`);
    return;
  }

  for (const t of [...tracks(v), ...tracks(a)]) assert.ok(tracks(c).includes(t), `${tag}inv-1: ${t.id} in V/A but not in C`);
  for (const t of [...tracks(c), ...tracks(v), ...tracks(a)]) assert.notEqual(t.readyState, 'ended', `${tag}inv-2: ended track ${t.id} still in a stream`);
  if (v && a && v !== a) for (const t of tracks(v)) assert.ok(!tracks(a).includes(t), `${tag}inv-3: ${t.id} in both V and A`);

  const audio = c.getAudioTracks()[0];
  const sinkBound = a || (v && !media._audioEl);
  if (audio && sinkBound) {
    const inV = tracks(v).includes(audio), inA = tracks(a).includes(audio);
    if (v === c) assert.ok(inV, `${tag}inv-4 (fallback mode): audio must be in V`);
    else assert.equal(inV !== inA, true, `${tag}inv-4: audio must be in exactly one of V (${inV}) / A (${inA})`);
  }

  if (v) assert.equal(media._videoEl.srcObject, v, `${tag}inv-5: videoEl.srcObject is not V`);
  if (a) assert.equal(media._audioEl.srcObject, a, `${tag}inv-5: audioEl.srcObject is not A`);

  assert.ok(c.getVideoTracks().length <= 1, `${tag}inv-6: C has ${c.getVideoTracks().length} video tracks`);
  assert.ok(c.getAudioTracks().length <= 1, `${tag}inv-6: C has ${c.getAudioTracks().length} audio tracks`);
}

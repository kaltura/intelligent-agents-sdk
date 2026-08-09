import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptTracker, apportion } from '../../src/experience/transcript.js';

test('apportion spreads durationMs across words with offset', () => {
  const w = apportion('a b c', 300, 1000);
  assert.deepEqual(w.map((x) => x.word), ['a', 'b', 'c']);
  assert.equal(w[0].startMs, 1000);
  assert.equal(w[1].startMs, 1100);
  assert.equal(w[2].startMs, 1200);
});

test('ingestChunk filters empty sentinels', () => {
  const t = new TranscriptTracker();
  assert.equal(t.ingestChunk({ text: '', durationMs: 1, speechId: 's1' }), null);
  assert.equal(t.ingestChunk({ text: 'x', durationMs: 1, speechId: 's1' }), null);
});

test('barge-in: stale-speechId chunks are dropped after a new utterance', () => {
  const t = new TranscriptTracker();
  const a = t.ingestChunk({ text: 'hello', durationMs: 200, speechId: 'A-transcript-hi' });
  assert.ok(a);
  assert.equal(t.latestSpeechId, 'A-transcript-hi');
  // new user turn → new speechId becomes latest
  t.beginUtterance('B-transcript-stop');
  // a late chunk from the OLD utterance must be dropped
  assert.equal(t.ingestChunk({ text: 'world', durationMs: 200, speechId: 'A-transcript-hi' }), null);
  // a chunk from the new utterance flows
  assert.ok(t.ingestChunk({ text: 'sure', durationMs: 200, speechId: 'B-transcript-stop' }));
});

test('word timing accumulates within an utterance and resets on finish', () => {
  const t = new TranscriptTracker();
  t.ingestChunk({ text: 'one two', durationMs: 200, speechId: 's' });   // elapsed 0..200
  const second = t.ingestChunk({ text: 'three', durationMs: 100, speechId: 's' });
  assert.equal(second.words[0].startMs, 200);
  t.finishUtterance();
  // a fresh utterance starts timing at 0 again
  t.beginUtterance('s2');
  const fresh = t.ingestChunk({ text: 'go', durationMs: 50, speechId: 's2' });
  assert.equal(fresh.words[0].startMs, 0);
});

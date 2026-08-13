import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionService } from '../../src/experience/captions.js';
import { Emitter } from '../../src/experience/emitter.js';

/** Minimal fake session — CaptionService only needs on/off/emit. */
class FakeSession extends Emitter {}

function mkCaptions(opts) {
  const session = new FakeSession();
  const events = [];
  const captions = new CaptionService(session, opts);
  captions.onCaption((e) => events.push(e));
  return { session, captions, events };
}

// ── Regex-based text segmentation (via the server-timed path, which segments
// commitText through CaptionSegmenter.segment before queuing) ──

test('segmentation: a long single chunk splits into multiple sentence segments', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 20, maxLines: 1 });
  const longText = 'This is the first sentence. This is the second sentence. This is the third.';
  session.emit('speechChunk', { text: longText, durationMs: 5000, speechId: 's1' });
  session.emit('avatarStopTalking', { text: longText });
  // The FIRST segment is emitted synchronously by _commitServerBuffer's initial
  // _drainServerQueue() call; the rest drain on later setTimeout ticks.
  assert.ok(events.length >= 1, 'at least the first segment emitted synchronously');
  assert.ok(events[0].text.length <= 25, 'first emitted segment respects the small maxChars budget');
  captions.destroy();
});

test('segmentation: HTML tags are stripped from caption text', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('speechChunk', { text: 'hello <b>world</b> done.', durationMs: 500, speechId: 's1' });
  session.emit('avatarStopTalking', { text: 'hello <b>world</b> done.' });
  assert.ok(events.length >= 1);
  assert.ok(!events.some((e) => e.text.includes('<b>')), 'no raw HTML tag reaches a caption event');
  captions.destroy();
});

test('segmentation: replacements map applies word-boundary-aware substitution', () => {
  const { session, events, captions } = mkCaptions({
    maxCharsPerLine: 200, maxLines: 2,
    replacements: { 'none gap': 'Non-GAAP' },
  });
  session.emit('speechChunk', { text: 'we discuss none gap earnings.', durationMs: 500, speechId: 's1' });
  session.emit('avatarStopTalking', { text: 'we discuss none gap earnings.' });
  assert.ok(events.some((e) => e.text.includes('Non-GAAP')), 'replacement applied');
  assert.ok(!events.some((e) => e.text.includes('none gap')), 'original phrase not leaked');
  captions.destroy();
});

// ── Server-timed path (speechChunk-driven, authoritative timing) ──

test('server-timed path: speechChunk drives a caption emission synchronously on commit', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('speechChunk', { text: 'Hello there. ', durationMs: 300, speechId: 's1' });
  assert.ok(events.length >= 1, 'a caption is emitted once a sentence boundary commits');
  assert.equal(events[0].clear, false);
  captions.destroy();
});

test('server-timed path: stopTalking flushes remaining buffer then holds+clears after holdAfterEndMs', async () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2, holdAfterEndMs: 30 });
  session.emit('speechChunk', { text: 'partial no boundary yet', durationMs: 400, speechId: 's1' });
  session.emit('avatarStopTalking', { text: 'partial no boundary yet' });
  // flush() commits the tail even without a trailing whitespace boundary
  assert.ok(events.some((e) => !e.clear && e.text.includes('partial')), 'flushed tail text emitted');
  // The remaining queued segment(s) drain proportionally over the original
  // 400ms speechChunk duration before the holdAfterEndMs clear timer even arms.
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(events.some((e) => e.clear === true), 'a clear event eventually fires after the hold window');
  captions.destroy();
});

test('server-timed path: interrupted() clears immediately and resets state', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('speechChunk', { text: 'Hello world. ', durationMs: 300, speechId: 's1' });
  session.emit('interrupted', {});
  assert.ok(events.some((e) => e.clear === true), 'interrupt emits a clear event');
  captions.destroy();
});

test('server-timed path: a non-finite or non-positive durationMs falls back to 100ms', () => {
  const { session, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  // A single word with no whitespace boundary — _commitServerBuffer (captions.js:401-402)
  // finds no boundary and returns early, leaving _serverDurationBuffer inspectable.
  session.emit('speechChunk', { text: 'Helloworld', durationMs: NaN, speechId: 's1' });
  assert.equal(captions._serverDurationBuffer, 100, 'NaN durationMs falls back to the 100ms default');
  captions.destroy();
});

test('server-timed path: a non-positive durationMs (<=0) also falls back to 100ms', () => {
  const { session, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('speechChunk', { text: 'Helloworld', durationMs: 0, speechId: 's1' });
  assert.equal(captions._serverDurationBuffer, 100, '0 durationMs falls back to the 100ms default');
  captions.destroy();
});

test('server-timed path: a buffer exceeding 2000 chars force-flushes even with no whitespace boundary', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  // One giant word (no whitespace anywhere) — without the length>2000 override
  // (captions.js:400), _commitServerBuffer would find no boundary and never flush.
  const longWord = 'a'.repeat(2500);
  session.emit('speechChunk', { text: longWord, durationMs: 5000, speechId: 's1' });
  assert.equal(captions._serverTextBuffer, '', 'the oversized buffer was force-flushed, not left pending');
  assert.ok(events.length >= 1, 'the force-flushed text was segmented and emitted');
  captions.destroy();
});

test('server-timed path: a mid-stream speechId change interrupts the in-flight response', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('speechChunk', { text: 'Hello world. ', durationMs: 300, speechId: 's1' });
  assert.ok(events.some((e) => !e.clear), 'first response emitted a caption');
  const clearsBefore = events.filter((e) => e.clear === true).length;
  // A new speechId while still active takes the `rid !== this._responseId` branch
  // in _onServerChunk (captions.js:365-367), which calls _interruptServer() first.
  session.emit('speechChunk', { text: 'A different response. ', durationMs: 300, speechId: 's2' });
  assert.equal(events.filter((e) => e.clear === true).length, clearsBefore + 1, '_interruptServer() cleared the old response');
  assert.ok(events.some((e) => e.text.includes('different response')), 'the new response still renders after the interrupt');
  captions.destroy();
});

// ── Heuristic fallback path (transcript{type:'partial'}, no speechChunk) ──

test('heuristic path: partial transcripts accumulate and emit on avatarStartTalking once a full sentence lands', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('transcript', { type: 'partial', text: 'Hello there.', speechId: 's1' });
  session.emit('avatarStartTalking', {});
  assert.ok(events.some((e) => !e.clear && e.text.includes('Hello there')), 'heuristic path renders the completed sentence');
  captions.destroy();
});

test('heuristic path: rate calibration runs without throwing and still displays segments', async () => {
  // calibrate() itself is pure math (exponential smoothing of chars/sec); this
  // exercises it end-to-end through _onAvatarStopTalking without asserting the
  // internal (unexported) charsPerSec value directly.
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  session.emit('transcript', { type: 'partial', text: 'Short reply now.', speechId: 's1' });
  session.emit('avatarStartTalking', {});
  await new Promise((r) => setTimeout(r, 10));
  session.emit('avatarStopTalking', { text: '' });   // no fullText, calibration falls back to textBuffer
  assert.ok(events.some((e) => !e.clear), 'segments were shown via the heuristic tick/display path');
  captions.destroy();
});

test('heuristic path: ground truth (transcript final) corrects word boundaries without being rendered directly', () => {
  const { session, events, captions } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  // final (ground truth) arrives first — must never be rendered as a caption itself
  session.emit('transcript', { type: 'final', text: 'The exact clean sentence.', speechId: 's1' });
  assert.equal(events.length, 0, 'ground truth alone renders nothing');
  session.emit('transcript', { type: 'partial', text: 'The exact clean sentence.', speechId: 's1' });
  session.emit('avatarStartTalking', {});
  assert.ok(events.some((e) => e.text.includes('exact clean sentence')), 'partial path renders, using GT for boundaries');
  captions.destroy();
});

test('destroy() detaches listeners — further session events produce no more captions', () => {
  const { session, captions, events } = mkCaptions({ maxCharsPerLine: 200, maxLines: 2 });
  captions.destroy();
  events.length = 0;
  session.emit('speechChunk', { text: 'should not appear.', durationMs: 300, speechId: 's1' });
  assert.equal(events.length, 0, 'no callbacks fire after destroy()');
});

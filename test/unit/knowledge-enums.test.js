import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTER_TYPE,
  STRATEGY,
  EMBED,
  MODALITIES,
  normalizeModality,
  buildIndexerObjects,
} from '../../src/core/knowledge-enums.js';
import { KalturaError } from '../../src/core/errors.js';

/**
 * Knowledge/RAG indexer enums + pure objects[] builder. The load-bearing
 * facts: ChapterType CAPTION=1/OCR=2/DOCUMENT=3,
 * StrategyEnum Embed{Caption,Ocr,Document}V1, and the wire field is
 * `indexPosition` (camelCase) NOT `index_position`.
 */

test('CHAPTER_TYPE has the exact documented numeric values', () => {
  assert.equal(CHAPTER_TYPE.CAPTION, 1);
  assert.equal(CHAPTER_TYPE.OCR, 2);
  assert.equal(CHAPTER_TYPE.DOCUMENT, 3);
});

test('STRATEGY maps each chapter type to its EmbedXxxV1 string', () => {
  assert.equal(STRATEGY.CAPTION, 'EmbedCaptionV1');
  assert.equal(STRATEGY.OCR, 'EmbedOcrV1');
  assert.equal(STRATEGY.DOCUMENT, 'EmbedDocumentV1');
});

test('EMBED pairs each lowercase modality with its {type,strategy}', () => {
  assert.deepEqual(EMBED.caption, { type: 1, strategy: 'EmbedCaptionV1' });
  assert.deepEqual(EMBED.ocr, { type: 2, strategy: 'EmbedOcrV1' });
  assert.deepEqual(EMBED.document, { type: 3, strategy: 'EmbedDocumentV1' });
});

test('enums are frozen (no accidental mutation of the snapshot)', () => {
  assert.throws(() => { CHAPTER_TYPE.OCR = 99; }, TypeError);
  assert.throws(() => { STRATEGY.OCR = 'x'; }, TypeError);
  assert.throws(() => { EMBED.ocr.type = 0; }, TypeError);
  assert.equal(CHAPTER_TYPE.OCR, 2);
  assert.equal(EMBED.ocr.type, 2);
});

test('SUMMARY is intentionally NOT a linkable modality', () => {
  assert.equal('summary' in EMBED, false);
  assert.equal(MODALITIES.includes('summary'), false);
});

test('normalizeModality accepts names, type keys casing, and numeric ChapterType', () => {
  assert.equal(normalizeModality('caption'), 'caption');
  assert.equal(normalizeModality('OCR'), 'ocr');
  assert.equal(normalizeModality(' Document '), 'document');
  assert.equal(normalizeModality(1), 'caption');
  assert.equal(normalizeModality(2), 'ocr');
  assert.equal(normalizeModality(3), 'document');
});

test('normalizeModality throws bad_request KalturaError on unknown input', () => {
  assert.throws(() => normalizeModality('summary'), (e) => e instanceof KalturaError && e.code === 'bad_request');
  assert.throws(() => normalizeModality(7), (e) => e instanceof KalturaError && e.code === 'bad_request');
  assert.throws(() => normalizeModality({}), (e) => e instanceof KalturaError && e.code === 'bad_request');
});

test('buildIndexerObjects uses indexPosition (camelCase), NOT index_position', () => {
  const objs = buildIndexerObjects(['ocr']);
  assert.equal(objs.length, 1);
  const o = objs[0];
  assert.equal('indexPosition' in o, true);
  assert.equal('index_position' in o, false);
  assert.deepEqual(o, { indexPosition: 0, type: 2, strategy: 'EmbedOcrV1' });
});

test('buildIndexerObjects builds a full OCR-capable objects[] with ordered positions', () => {
  const objs = buildIndexerObjects(['document', 'caption', 'ocr']);
  assert.deepEqual(objs, [
    { indexPosition: 0, type: 3, strategy: 'EmbedDocumentV1' },
    { indexPosition: 1, type: 1, strategy: 'EmbedCaptionV1' },
    { indexPosition: 2, type: 2, strategy: 'EmbedOcrV1' },
  ]);
});

test('buildIndexerObjects defaults to all three modalities when omitted or empty', () => {
  const def = buildIndexerObjects();
  assert.deepEqual(def.map((o) => o.type), [3, 1, 2]);
  assert.deepEqual(buildIndexerObjects([]).map((o) => o.strategy), ['EmbedDocumentV1', 'EmbedCaptionV1', 'EmbedOcrV1']);
  assert.deepEqual(buildIndexerObjects(null), def);
});

test('buildIndexerObjects accepts numeric ChapterType tokens and re-indexes by order', () => {
  const objs = buildIndexerObjects([2, 'DOCUMENT']);
  assert.deepEqual(objs, [
    { indexPosition: 0, type: 2, strategy: 'EmbedOcrV1' },
    { indexPosition: 1, type: 3, strategy: 'EmbedDocumentV1' },
  ]);
});

test('buildIndexerObjects rejects duplicate modalities (no double-embed)', () => {
  assert.throws(
    () => buildIndexerObjects(['ocr', 'OCR']),
    (e) => e instanceof KalturaError && e.code === 'bad_request' && /duplicate/i.test(e.detail),
  );
  assert.throws(
    () => buildIndexerObjects(['document', 3]),
    (e) => e instanceof KalturaError && e.code === 'bad_request',
  );
});

test('buildIndexerObjects rejects unknown modality with a named bad_request', () => {
  assert.throws(
    () => buildIndexerObjects(['caption', 'audio']),
    (e) => e instanceof KalturaError && e.code === 'bad_request' && /audio/.test(e.detail),
  );
});

test('buildIndexerObjects rejects a non-array types arg before any work', () => {
  assert.throws(() => buildIndexerObjects('ocr'), (e) => e instanceof KalturaError && e.code === 'bad_request');
  assert.throws(() => buildIndexerObjects(5), (e) => e instanceof KalturaError && e.code === 'bad_request');
});

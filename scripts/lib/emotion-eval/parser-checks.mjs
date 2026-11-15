/**
 * Offline checks of how the SDK parsers treat the emotion field. No network.
 * Each check feeds a synthetic converse stream through `parseConverseStream` and `collectConverse`,
 * then asks `turnFacts` (the eval's own reader) what it sees.
 */
import { parseConverseStream, collectConverse } from '../../../src/core/stream.js';
import { turnFacts } from './analyze.mjs';

/** @param {string} text */
function streamFrom(text) {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(enc.encode(text));
    },
  });
}

/** Parse chunks the way the SDK does. Returns the raw segments and the collected result. @param {object[]} chunks */
async function parse(chunks) {
  const body = chunks.map((c) => `${JSON.stringify(c)}\n`).join('');
  const segs = [];
  for await (const s of parseConverseStream(streamFrom(body))) segs.push(s);
  const collected = await collectConverse((async function* () { yield* segs; })());
  return { segs, collected };
}

/** Reduce parsed segments to the shape the eval stores. @param {any[]} segs */
function toRecord(segs) {
  return segs.map((s) => {
    const r = { type: s.type, content: s.content, segmentStart: !!s.segmentStart, segmentEnd: !!s.segmentEnd };
    return s.metadata && Object.prototype.hasOwnProperty.call(s.metadata, 'emotion') ? { ...r, emotion: s.metadata.emotion } : r;
  });
}

const av = (content, extra = {}) => ({ type: 'avatar', content, ...extra });
const start = (content, emotion) => av(content, { segmentStart: true, ...(emotion === undefined ? {} : { metadata: { emotion } }) });

/** @type {{id:string, name:string, run:() => Promise<{pass:boolean, detail:string}>}[]} */
const CHECKS = [
  {
    id: 'unknown-label',
    name: 'An unknown label passes through the SDK unchanged, and the eval flags it as invalid',
    run: async () => {
      const { segs } = await parse([start('Hm.', 'confused'), av(' ok.', { segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      const pass = segs[0].metadata.emotion === 'confused' && f.invalid.length === 1 && f.valid.length === 0;
      return { pass, detail: `sdk value ${JSON.stringify(segs[0].metadata?.emotion)}, flagged invalid ${f.invalid.length}` };
    },
  },
  {
    id: 'non-string',
    name: 'Non-string values (number, null, object, empty string, wrong case) are flagged as invalid',
    run: async () => {
      const values = [3, null, { a: 1 }, '', 'Happy', ' sad'];
      const chunks = values.flatMap((v) => [start('x', v), av('y', { segmentEnd: true })]);
      const { segs } = await parse(chunks);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.invalid.length === values.length && f.valid.length === 0, detail: `${f.invalid.length} of ${values.length} flagged` };
    },
  },
  {
    id: 'absent-metadata',
    name: 'Without metadata no emotion key appears on any chunk',
    run: async () => {
      const { segs } = await parse([av('Hello.', { segmentStart: true }), av(' there.', { segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.emotionChunks === 0 && segs.every((s) => !('metadata' in s)), detail: `${f.emotionChunks} emotion chunks` };
    },
  },
  {
    id: 'collect-keeps-metadata',
    name: 'collectConverse keeps metadata.emotion on its segments list, in order (the send path)',
    run: async () => {
      const { collected } = await parse([start('Oh no.', 'sad'), av(' Hard.', { segmentEnd: true }), start('Cheer up!', 'happy'), av(' Yes.', { segmentEnd: true, isFinal: true })]);
      const got = (collected.segments ?? []).filter((s) => s.metadata?.emotion).map((s) => s.metadata.emotion);
      return { pass: got.join() === 'sad,happy' && collected.text === 'Oh no. Hard.Cheer up! Yes.', detail: `labels ${got.join(',')}` };
    },
  },
  {
    id: 'order-before',
    name: 'Ordering: the emotion arrives on the start chunk, before the rest of its segment text',
    run: async () => {
      const { segs } = await parse([start('One', 'happy'), av(' two'), av(' three', { segmentEnd: true, isFinal: true })]);
      const r = toRecord(segs);
      const f = turnFacts({ ok: true, segments: r });
      const idx = r.findIndex((s) => 'emotion' in s);
      return { pass: idx === 0 && f.misplaced === 0, detail: `emotion at chunk ${idx}, misplaced ${f.misplaced}` };
    },
  },
  {
    id: 'order-after',
    name: 'Ordering: an emotion that arrives after its text (not on a start chunk) is flagged as misplaced',
    run: async () => {
      const { segs } = await parse([av('One', { segmentStart: true }), av(' two', { metadata: { emotion: 'sad' } }), av(' three', { segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.misplaced === 1, detail: `misplaced ${f.misplaced}` };
    },
  },
  {
    id: 'duplicate-label',
    name: 'The same label on two segments in a row is counted as a repeat',
    run: async () => {
      const { segs } = await parse([start('A', 'sad'), av('a', { segmentEnd: true }), start('B', 'sad'), av('b', { segmentEnd: true }), start('C', 'happy'), av('c', { segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.repeats === 1 && f.avatarSegments === 3, detail: `repeats ${f.repeats}, segments ${f.avatarSegments}` };
    },
  },
  {
    id: 'missing-on-some',
    name: 'A segment without an emotion is allowed and counted as unlabeled',
    run: async () => {
      const { segs } = await parse([start('A', 'sad'), av('a', { segmentEnd: true }), start('B'), av('b', { segmentEnd: true }), start('C', 'happy'), av('c', { segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.avatarSegments === 3 && f.startLabels.length === 2, detail: `segments ${f.avatarSegments}, labeled ${f.startLabels.length}` };
    },
  },
  {
    id: 'text-tag-not-parsed',
    name: 'A bracket emotion tag in spoken text stays text. The SDK does not turn it into metadata',
    run: async () => {
      const { segs } = await parse([av('[emotion: angry] Fine.', { segmentStart: true, segmentEnd: true, isFinal: true })]);
      const f = turnFacts({ ok: true, segments: toRecord(segs) });
      return { pass: f.emotionChunks === 0 && f.textTag, detail: `emotion chunks ${f.emotionChunks}, tag seen in text ${f.textTag}` };
    },
  },
];

/**
 * Run all parser checks.
 * @returns {Promise<{id:string, name:string, pass:boolean, detail:string}[]>}
 */
export async function runParserChecks() {
  const out = [];
  for (const c of CHECKS) {
    try {
      const r = await c.run();
      out.push({ id: c.id, name: c.name, pass: r.pass, detail: r.detail });
    } catch (err) {
      out.push({ id: c.id, name: c.name, pass: false, detail: `threw: ${/** @type {any} */ (err)?.message ?? err}` });
    }
  }
  return out;
}

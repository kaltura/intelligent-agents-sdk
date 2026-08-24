import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRuntime, isKnownRuntime, parseContent, parseWidget,
  RUNTIMES, GENUI_WIDGET_NAME,
} from '../../src/experience/genui/parse.js';
import { SegmentAssembler } from '../../src/experience/genui/segments.js';
import { ExperienceRenderer } from '../../src/experience/genui/renderer.js';
import { DEFAULT_RENDERERS } from '../../src/experience/genui/renderers/index.js';
import { renderFollowups } from '../../src/experience/genui/renderers/followups.js';

/** GenUI segment→widget layer. Pure parse + dispatch + fallback + each default renderer shape. */

// ─────────────────────────── normalizeRuntime ───────────────────────────

test('normalizeRuntime strips -tool and tolerates pre-stripped / non-string', () => {
  assert.equal(normalizeRuntime('flashcards-tool'), 'flashcards');
  assert.equal(normalizeRuntime('flashcards'), 'flashcards');
  assert.equal(normalizeRuntime('  user-properties-form-tool  '), 'user-properties-form');
  assert.equal(normalizeRuntime(null), '');
  assert.equal(normalizeRuntime(42), '');
});

test('RUNTIMES is the frozen nine-name set, all known', () => {
  assert.equal(RUNTIMES.length, 9);
  assert.ok(Object.isFrozen(RUNTIMES));
  for (const r of RUNTIMES) assert.equal(isKnownRuntime(r), true);
  assert.equal(isKnownRuntime('flashcards-tool'), true);   // un-stripped still resolves
  assert.equal(isKnownRuntime('gen-ui-composer'), false);  // extra backend runtime → not first-class
});

// ─────────────────────────── parseContent (forgiving) ───────────────────────────

test('parseContent: object passthrough, array → items, null → {}', () => {
  assert.deepEqual(parseContent({ a: 1 }), { a: 1 });
  assert.deepEqual(parseContent([1, 2]), { items: [1, 2] });
  assert.deepEqual(parseContent(null), {});
  assert.deepEqual(parseContent(undefined), {});
});

test('parseContent: JSON string (incl. fenced) parses', () => {
  assert.deepEqual(parseContent('{"title":"T","cards":[]}'), { title: 'T', cards: [] });
  assert.deepEqual(parseContent('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(parseContent('[1,2,3]'), { items: [1, 2, 3] });
});

test('parseContent: loose key:value line block, leftovers under .raw, never throws', () => {
  const m = parseContent('title: Hello\nactive: true\ncount: 3\njust some prose');
  assert.equal(m.title, 'Hello');
  assert.equal(m.active, true);
  assert.equal(m.count, 3);
  assert.equal(m.raw, 'just some prose');
  // garbage never throws
  assert.deepEqual(parseContent('{not valid json'), { raw: '{not valid json' });
});

// ─────────────────────────── issue #56: quote-stripping + flush-left dash lists ───────────────────────────

test('parseContent (issue #56): coerceScalar strips a matching pair of surrounding quotes from a live show-link URL', () => {
  // Live-observed shape: a show-link widget's model comes back with the literal
  // quote characters retained around the URL, e.g. {link: '"https://example.com/widgetron"'}.
  const m = parseContent('link: "https://example.com/widgetron"');
  assert.equal(m.link, 'https://example.com/widgetron');
  // single-quote pair is stripped too
  assert.equal(parseContent("label: 'Go to site'").label, 'Go to site');
});

test('parseContent: quote-stripping never eats a lone/unbalanced quote or an internal apostrophe', () => {
  // no surrounding pair — leading quote only → left as-is
  assert.equal(parseContent('label: "unterminated').label, '"unterminated');
  // internal apostrophe, not a surrounding pair → left as-is
  assert.equal(parseContent("note: it's fine").note, "it's fine");
  // too short to be a pair (single char) → left as-is
  assert.equal(parseContent('key: "').key, '"');
});

test('parseContent + renderFollowups (issue #56): flush-left dash list populates model.questions as a real array, verified through the followups renderer', () => {
  // Exact live-observed shape: the backend emits a flush-left dash list (zero
  // leading whitespace) for the followups tool's `questions:` field.
  const content = 'questions:\n- "What specific feature are you most excited about?"\n- "How does this compare to your current solution?"';
  const model = parseContent(content);
  assert.deepEqual(model.questions, [
    'What specific feature are you most excited about?',
    'How does this compare to your current solution?',
  ]);
  assert.equal(model.raw, undefined);   // previously the dash lines leaked into .raw as an unparsed blob

  const rendered = renderFollowups(model);
  assert.deepEqual(rendered.data.questions, [
    'What specific feature are you most excited about?',
    'How does this compare to your current solution?',
  ]);
});

test('parseContent: indented "- key: value" sub-map list (e.g. fields:) still parses as maps, unaffected by the flush-left fix', () => {
  const content = 'fields:\n  - key: email\n    type: email\n  - key: role\n    type: str';
  const model = parseContent(content);
  assert.deepEqual(model.fields, [
    { key: 'email', type: 'email' },
    { key: 'role', type: 'str' },
  ]);
});

// ─────────────────────────── parseWidget ───────────────────────────

test('parseWidget extracts widgetName/runtimeName/runtime/model from a live segment', () => {
  const seg = {
    type: 'unisphere-tool',
    content: { questions: ['q1', 'q2'] },
    metadata: { widgetName: GENUI_WIDGET_NAME, runtimeName: 'followups-tool' },
  };
  const w = parseWidget(seg);
  assert.equal(w.widgetName, GENUI_WIDGET_NAME);
  assert.equal(w.runtimeName, 'followups-tool');
  assert.equal(w.runtime, 'followups');
  assert.deepEqual(w.model, { questions: ['q1', 'q2'] });
});

test('parseWidget handles a flattened headless feed + string content', () => {
  const w = parseWidget({ runtimeName: 'summary', content: '```\nsummary: Q1 was strong\n```' });
  assert.equal(w.runtime, 'summary');
  assert.equal(w.widgetName, GENUI_WIDGET_NAME);
  assert.equal(w.model.summary, 'Q1 was strong');
});

test('parseWidget never throws on garbage; yields empty runtime', () => {
  assert.equal(parseWidget(null).runtime, '');
  assert.equal(parseWidget(42).runtime, '');
  assert.equal(parseWidget({}).runtime, '');
  assert.deepEqual(parseWidget({}).model, {});
});

// ─────────────────────────── dispatch + fallback ───────────────────────────

test('ExperienceRenderer.render dispatches by normalized runtime', () => {
  const r = new ExperienceRenderer();
  const d = r.render('flashcards-tool', { cards: [{ front: 'F', back: 'B' }] });
  assert.equal(d.kind, 'flashcards');
  assert.equal(d.runtime, 'flashcards');
  assert.equal(d.runtimeName, 'flashcards-tool');
  assert.equal(d.data.cards[0].front, 'F');
  assert.equal(d._meta.source, 'experience/genui');
  assert.ok(/Z$/.test(d._meta.generatedAt));
  assert.equal(d._meta.known, true);
  assert.equal(r.last, d);
});

test('ExperienceRenderer: unknown runtime → safe fallback, never throws, fires onUnhandled', () => {
  const seen = [];
  const r = new ExperienceRenderer({ onUnhandled: (i) => seen.push(i) });
  const d = r.render('gen-ui-composer-tool', { foo: 'bar' });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.runtime, 'gen-ui-composer');
  assert.deepEqual(d.data.model, { foo: 'bar' });
  assert.equal(d._meta.known, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runtime, 'gen-ui-composer');
});

test('ExperienceRenderer.register overrides a renderer (normalized key) + chains', () => {
  const r = new ExperienceRenderer();
  const ret = r.register('summary-tool', (m) => ({ kind: 'summary', data: { custom: m.summary } }));
  assert.equal(ret, r);
  const d = r.render('summary', { summary: 'X' });
  assert.equal(d.data.custom, 'X');
  assert.equal(r.has('summary'), true);
  assert.equal(r.runtimes.length, Object.keys(DEFAULT_RENDERERS).length);   // override, not add
});

test('ExperienceRenderer.register throws bad_request on bad name/fn (before use)', () => {
  const r = new ExperienceRenderer();
  assert.throws(() => r.register('', () => ({})), (e) => e.code === 'bad_request');
  assert.throws(() => r.register('summary', 123), (e) => e.code === 'bad_request');
});

test('ExperienceRenderer ctor throws bad_request on bad mount/onUnhandled', () => {
  assert.throws(() => new ExperienceRenderer({ mount: 5 }), (e) => e.code === 'bad_request');
  assert.throws(() => new ExperienceRenderer({ onUnhandled: 'x' }), (e) => e.code === 'bad_request');
});

test('ExperienceRenderer: a throwing custom renderer degrades to kind:error, never throws', () => {
  const r = new ExperienceRenderer();
  r.register('summary', () => { throw new Error('boom'); });
  const d = r.render('summary', {});
  assert.equal(d.kind, 'error');
  assert.equal(d.data.message, 'boom');
});

test('ExperienceRenderer mount sink receives each descriptor; replace keeps only last', () => {
  const out = [];
  const r = new ExperienceRenderer({ mount: (d) => out.push(d), replace: true });
  r.render('followups', { questions: ['a'] });
  r.render('summary', { summary: 's' });
  assert.equal(out.length, 2);
  assert.equal(r.rendered.length, 1);             // replace → only last accumulates
  assert.equal(r.rendered[0].kind, 'summary');
  r.clear();
  assert.equal(r.last, null);
  assert.equal(r.rendered.length, 0);
});

test('a throwing mount sink never breaks render', () => {
  const r = new ExperienceRenderer({ mount: () => { throw new Error('host bug'); } });
  assert.doesNotThrow(() => r.render('followups', { questions: ['a'] }));
});

// ─────────────────────────── each default renderer shape ───────────────────────────

test('default renderers cover exactly the nine built-in GenUI runtimes', () => {
  assert.equal(Object.keys(DEFAULT_RENDERERS).length, 9);
  for (const rt of RUNTIMES) assert.equal(typeof DEFAULT_RENDERERS[rt], 'function');   // the nine
});

test('renderer shape: flashcards', () => {
  const d = new ExperienceRenderer().render('flashcards', { title: 'T', cards: [{ question: 'Q', answer: 'A' }] });
  assert.equal(d.data.title, 'T');
  assert.deepEqual(d.data.cards, [{ front: 'Q', back: 'A', label: 'Q' }]);   // label = accessible name (falls back to front)
});

test('renderer shape: followups (string + object items)', () => {
  const d = new ExperienceRenderer().render('followups', { questions: ['q1', { text: 'q2' }, ''] });
  assert.deepEqual(d.data.questions, ['q1', 'q2']);   // empty dropped
});

test('renderer shape: sources (url scheme-checked)', () => {
  const d = new ExperienceRenderer().render('sources', {
    sources: [{ title: 'OK', url: 'https://k.com/a', snippet: 's' }, { title: 'XSS', url: 'javascript:alert(1)' }],
  });
  assert.equal(d.data.sources[0].url, 'https://k.com/a');
  assert.equal(d.data.sources[1].url, '');            // dangerous scheme stripped
});

test('renderer shape: summary (bullets + text)', () => {
  const d = new ExperienceRenderer().render('summary', { title: 'T', summary: 'body', bullets: ['a', 'b', ''] });
  assert.equal(d.data.summary, 'body');
  assert.deepEqual(d.data.bullets, ['a', 'b']);
});

test('renderer shape: summary extracts text from object bullets (live show_widget payload shape)', () => {
  // Captured live 2026-08-03: the brain sent bullets as [{summary:"…"}] rows — a string
  // coercion rendered the literal "[object Object]" for each.
  const d = new ExperienceRenderer().render('summary', {
    title: 'Subscription vs. Professional Services Revenue',
    bullets: [
      { summary: 'Q1 2026: Subscription $43.2M, Professional Services $1.4M' },
      { text: 'Q4 2025: Subscription $42.7M, Professional Services $2.9M' },
      { label: 'Q3 2025: Subscription $42.0M' },
      {},                    // no text field → dropped, not "[object Object]"
      'plain string',
    ],
  });
  assert.deepEqual(d.data.bullets, [
    'Q1 2026: Subscription $43.2M, Professional Services $1.4M',
    'Q4 2025: Subscription $42.7M, Professional Services $2.9M',
    'Q3 2025: Subscription $42.0M',
    'plain string',
  ]);
  for (const b of d.data.bullets) assert.ok(!b.includes('[object Object]'));
});

test('renderer shape: summary unwraps a mis-nested {summary:{title,bullets}} payload (live show_widget shape)', () => {
  // Captured live 2026-08-03 for the Forward-Looking Statements slide: the brain sent
  // {"data":{"summary":{"title":"…","bullets":[…]}}} — nesting the whole flat shape one
  // level deeper inside `summary` — which used to string-coerce to "[object Object]".
  const d = new ExperienceRenderer().render('summary', {
    kind: 'summary',
    summary: {
      title: 'Forward-Looking Statements & Non-GAAP Financial Measures',
      bullets: ['This presentation contains forward-looking statements.', 'Non-GAAP measures are reconciled in the appendix.'],
    },
  });
  assert.equal(d.data.title, 'Forward-Looking Statements & Non-GAAP Financial Measures');
  assert.deepEqual(d.data.bullets, [
    'This presentation contains forward-looking statements.',
    'Non-GAAP measures are reconciled in the appendix.',
  ]);
  assert.ok(!d.data.summary.includes('[object Object]'));
});

test('renderer shape: video-gallery (entryId preserved, urls checked)', () => {
  const d = new ExperienceRenderer().render('video-gallery', {
    videos: [{ entryId: '1_abc', title: 'V', url: 'https://k.com/v', thumbnailUrl: 'data:x' }],
  });
  assert.equal(d.data.videos[0].entryId, '1_abc');
  assert.equal(d.data.videos[0].url, 'https://k.com/v');
  assert.equal(d.data.videos[0].thumbnailUrl, '');    // data: blocked
});

test('video-gallery derives a real Kaltura thumbnail + player-embed from entryId + partnerId', () => {
  // No explicit thumbnail/url → derive both from the entry id + partnerId (the common case).
  const d = new ExperienceRenderer({ partnerId: '6516742', uiConfId: '58022082' })
    .render('video-gallery', { videos: [{ entryId: '1_abc', title: 'V' }] });
  const v = d.data.videos[0];
  assert.match(v.thumbnailUrl, /^https:\/\/cfvod\.kaltura\.com\/p\/6516742\/sp\/651674200\/thumbnail\/entry_id\/1_abc\//);
  assert.match(v.embedUrl, /extwidget\/preview\/partner_id\/6516742\/uiconf_id\/58022082\/entry_id\/1_abc\/embed\/iframe$/);
});

test('video-gallery without a partnerId leaves derived URLs empty (no guessing)', () => {
  const d = new ExperienceRenderer().render('video-gallery', { videos: [{ entryId: '1_abc' }] });
  assert.equal(d.data.videos[0].thumbnailUrl, '');
  assert.equal(d.data.videos[0].embedUrl, '');
});

test('external-video promotes a known host to a real iframe embedUrl; unknown host → link only', () => {
  const yt = new ExperienceRenderer().render('external-video', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Clip' });
  assert.equal(yt.data.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(yt.data.provider, 'YouTube');
  const other = new ExperienceRenderer().render('external-video', { url: 'https://example.com/v.mp4' });
  assert.equal(other.data.embedUrl, '');               // not an embed host → no iframe, link fallback
  assert.equal(other.data.url, 'https://example.com/v.mp4');
});

test('renderer shape: show-link (safe flag flips on dangerous href)', () => {
  const ok = new ExperienceRenderer().render('show-link', { url: 'https://k.com', label: 'Go' });
  assert.equal(ok.data.url, 'https://k.com');
  assert.equal(ok.data.safe, true);
  const bad = new ExperienceRenderer().render('show-link', { url: 'javascript:evil()', label: '<img onerror=x>' });
  assert.equal(bad.data.url, '');                      // dangerous href stripped → safe descriptor
  assert.equal(bad.data.safe, false);
  // safeText keeps the raw label (control chars stripped); the host neutralizes markup
  // via textContent — the SDK never emits HTML, so the angle-bracket label is data, not markup.
  assert.equal(bad.data.label, '<img onerror=x>');
});

test('renderer shape: external-video (http(s)-only, mailto blocked)', () => {
  const ok = new ExperienceRenderer().render('external-video', { url: 'https://youtube.com/x', title: 'Clip' });
  assert.equal(ok.data.url, 'https://youtube.com/x');
  assert.equal(ok.data.safe, true);
  const bad = new ExperienceRenderer().render('external-video', { url: 'mailto:x@y.com' });
  assert.equal(bad.data.url, '');                      // not http(s) → blocked even though safeUrl default allows mailto
  assert.equal(bad.data.safe, false);
});

test('renderer shape: user-properties-form (type coercion + known_value)', () => {
  const d = new ExperienceRenderer().render('user-properties-form', {
    title: 'Lead', properties: [
      { key: 'email', type: 'email', known_value: 'a@b.com' },
      { key: 'role', type: 'weird' },
      { key: '' },
    ],
  });
  assert.equal(d.data.title, 'Lead');
  assert.equal(d.data.fields.length, 2);               // keyless dropped
  assert.equal(d.data.fields[0].type, 'email');
  assert.equal(d.data.fields[0].knownValue, 'a@b.com');
  assert.equal(d.data.fields[1].type, 'str');          // unknown type → str
});

test('renderer shape: content-gallery (urls checked)', () => {
  const d = new ExperienceRenderer().render('content-gallery', {
    items: [{ title: 'C', description: 'd', imageUrl: 'https://k.com/i.png', url: 'vbscript:x' }],
  });
  assert.equal(d.data.items[0].imageUrl, 'https://k.com/i.png');
  assert.equal(d.data.items[0].url, '');               // vbscript blocked
});

// ─────────────────────────── SegmentAssembler ───────────────────────────

test('SegmentAssembler ignores non-widget segments', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  assert.equal(a.ingest({ type: 'text', content: 'spoken words' }), false);
  assert.equal(a.ingest(null), false);
  assert.equal(a.pending, false);
  assert.equal(out.length, 0);
});

test('SegmentAssembler concatenates string fragments for same runtime+speechId, flushes on turn end', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'sum', speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'mary: hi', speechId: 's1' });
  assert.equal(a.pending, true);
  assert.equal(out.length, 0);                         // not flushed mid-stream
  a.onTurnEnd('s1');
  assert.equal(out.length, 1);
  assert.equal(out[0].runtime, 'summary');
  assert.equal(out[0].model.summary, 'hi');            // "summary: hi" reassembled across chunks
  assert.equal(out[0].speechId, 's1');
});

test('SegmentAssembler (issue #53): realistic wire shape — only the FIRST fragment carries metadata, later fragments carry bare content and still get appended', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  a.ingest({ type: 'unisphere-tool', metadata: { widgetName: 'unisphere.widget.genie', runtimeName: 'summary-tool' }, content: '' });
  a.ingest({ type: 'unisphere-tool', content: '{"summary":"hi ' });               // no metadata key at all
  a.ingest({ type: 'unisphere-tool', content: 'there"}' });                       // no metadata key at all
  assert.equal(a.pending, true);
  assert.equal(out.length, 0);
  a.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].runtime, 'summary');
  assert.equal(out[0].model.summary, 'hi there');
});

test('SegmentAssembler (issue #53): a metadata-less fragment with no buffer open is still ignored as a non-widget segment', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  assert.equal(a.ingest({ type: 'unisphere-tool', content: 'orphan fragment' }), false);
  assert.equal(a.pending, false);
  assert.equal(out.length, 0);
});

test('SegmentAssembler (issue #53): a metadata-less non-unisphere-tool fragment never attaches to an open buffer', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  a.ingest({ type: 'unisphere-tool', metadata: { runtimeName: 'summary-tool' }, content: 'sum' });
  assert.equal(a.ingest({ type: 'text', content: 'spoken aside' }), false);
  a.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].model.summary, undefined);   // the spoken aside never merged into the buffer
});

test('SegmentAssembler flushes the previous widget when runtime changes', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  a.ingest({ metadata: { runtimeName: 'followups-tool' }, content: { questions: ['q'] }, speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: { cards: [] }, speechId: 's1' });
  assert.equal(out.length, 1);                         // followups flushed at the boundary
  assert.equal(out[0].runtime, 'followups');
  a.flush();
  assert.equal(out.length, 2);
  assert.equal(out[1].runtime, 'flashcards');
});

test('SegmentAssembler object content REPLACES; reset discards without emitting', () => {
  const out = [];
  const a = new SegmentAssembler({ onWidget: (w) => out.push(w) });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: { cards: [{ front: 'a' }] }, speechId: 's1' });
  a.reset();
  assert.equal(a.pending, false);
  assert.equal(a.flush(), false);
  assert.equal(out.length, 0);
});

test('SegmentAssembler: a throwing onWidget never breaks assembly', () => {
  const a = new SegmentAssembler({ onWidget: () => { throw new Error('host'); } });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'x', speechId: 's1' });
  assert.doesNotThrow(() => a.flush());
});

// ─────────────────────────── issue #26: onMalformed ───────────────────────────

test('SegmentAssembler: interrupted by a new speechId before a JSON widget completes → onMalformed, not onWidget', () => {
  const widgets = []; const malformed = [];
  const a = new SegmentAssembler({ onWidget: (w) => widgets.push(w), onMalformed: (m) => malformed.push(m) });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: '{"cards":[{"front":"a"', speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: 'x', speechId: 's2' });   // interrupts s1 mid-JSON
  assert.equal(widgets.length, 0);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].runtime, 'flashcards');
  assert.equal(malformed[0].reason, 'boundary');
  assert.match(malformed[0].message, /interrupted/i);
});

test('SegmentAssembler: interrupted by a different runtime before a JSON widget completes → onMalformed', () => {
  const widgets = []; const malformed = [];
  const a = new SegmentAssembler({ onWidget: (w) => widgets.push(w), onMalformed: (m) => malformed.push(m) });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: '[{"front":"a"}', speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'summary: hi', speechId: 's1' });
  a.onTurnEnd('s1');
  assert.equal(widgets.length, 1);              // the summary-tool widget itself completes fine
  assert.equal(widgets[0].runtime, 'summary');
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].runtime, 'flashcards');
});

test('SegmentAssembler: a small-but-complete non-JSON widget is NOT flagged malformed on interruption', () => {
  const widgets = []; const malformed = [];
  const a = new SegmentAssembler({ onWidget: (w) => widgets.push(w), onMalformed: (m) => malformed.push(m) });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'summary: hi', speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'more', speechId: 's2' });   // interrupts, but s1's body was never JSON-shaped
  assert.equal(malformed.length, 0);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].model.summary, 'hi');
});

test('SegmentAssembler: an object body is never malformed even on interruption (a parsed object is already whole)', () => {
  const widgets = []; const malformed = [];
  const a = new SegmentAssembler({ onWidget: (w) => widgets.push(w), onMalformed: (m) => malformed.push(m) });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: { cards: [] }, speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: { cards: [] }, speechId: 's2' });
  assert.equal(malformed.length, 0);
  assert.equal(widgets.length, 1);
});

test('SegmentAssembler: a natural turnEnd flush is never malformed, even mid-JSON (an abandoned turn, not an interruption)', () => {
  const widgets = []; const malformed = [];
  const a = new SegmentAssembler({ onWidget: (w) => widgets.push(w), onMalformed: (m) => malformed.push(m) });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: '{"cards":[', speechId: 's1' });
  a.onTurnEnd('s1');
  assert.equal(malformed.length, 0);
  assert.equal(widgets.length, 1);
});

test('SegmentAssembler: a throwing onMalformed never breaks assembly', () => {
  const a = new SegmentAssembler({ onMalformed: () => { throw new Error('host'); } });
  a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: '{"cards":[', speechId: 's1' });
  assert.doesNotThrow(() => a.ingest({ metadata: { runtimeName: 'flashcards-tool' }, content: 'x', speechId: 's2' }));
});

test('ExperienceRenderer LIVE mode: an interrupted JSON widget mounts a typed error descriptor, same shape as a throwing renderer', () => {
  const session = new FakeSession();
  const out = [];
  const r = new ExperienceRenderer({ session, mount: (d) => out.push(d) }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'flashcards-tool' }, content: '{"cards":[{"front":"a"', speechId: 's1' });
  session.emit('brainSegment', { metadata: { runtimeName: 'flashcards-tool' }, content: 'x', speechId: 's2' });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'error');
  assert.equal(out[0].data.runtime, 'flashcards');
  assert.match(out[0].data.message, /interrupted/i);
  assert.equal(out[0].runtimeName, 'flashcards-tool');
  assert.equal(r.last, out[0]);
});

// ─────────────────────────── live dual-mode wiring ───────────────────────────

class FakeSession {
  constructor() { this._h = new Map(); this.partnerId = '999'; }
  on(ev, fn) { (this._h.get(ev) || this._h.set(ev, new Set()).get(ev)).add(fn); return () => this._h.get(ev).delete(fn); }
  emit(ev, p) { for (const fn of this._h.get(ev) || []) fn(p); }
}

test('ExperienceRenderer LIVE mode: brainSegment → assembled widget → mount; stop unsubscribes', () => {
  const session = new FakeSession();
  const out = [];
  const r = new ExperienceRenderer({ session, mount: (d) => out.push(d) });
  r.start();
  assert.equal(r.start(), r);   // idempotent
  session.emit('brainSegment', { metadata: { runtimeName: 'followups-tool' }, content: { questions: ['q1'] }, speechId: 'sp1' });
  session.emit('turnEnd', { speechId: 'sp1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'followups');
  assert.deepEqual(out[0].data.questions, ['q1']);
  assert.equal(out[0]._meta.partnerId, '999');         // partnerId pulled from session
  r.stop();
  session.emit('brainSegment', { metadata: { runtimeName: 'summary-tool' }, content: 'summary: x', speechId: 'sp2' });
  session.emit('turnEnd', { speechId: 'sp2' });
  assert.equal(out.length, 1);                          // no more after stop()
});

test('ExperienceRenderer LIVE mode: interrupted discards the in-flight buffer', () => {
  const session = new FakeSession();
  const out = [];
  new ExperienceRenderer({ session, mount: (d) => out.push(d) }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'summary-tool' }, content: 'partial', speechId: 'sp1' });
  session.emit('interrupted', {});
  session.emit('turnEnd', { speechId: 'sp1' });
  assert.equal(out.length, 0);
});

test('ExperienceRenderer with no session: start() is a harmless no-op', () => {
  const r = new ExperienceRenderer();
  assert.doesNotThrow(() => r.start());
  assert.doesNotThrow(() => r.stop());
});

// ─────────────────────────── issue #28: clearOnTurnStart ───────────────────────────

test('ExperienceRenderer LIVE mode default: turnStart clears a widget rendered in the previous turn before the next one mounts', () => {
  const session = new FakeSession();
  const out = [];
  const r = new ExperienceRenderer({ session, mount: (d) => out.push(d) }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'followups-tool' }, content: { questions: ['turn 1'] }, speechId: 'sp1' });
  session.emit('turnEnd', { speechId: 'sp1' });
  assert.equal(out.length, 1);
  assert.equal(r.last, out[0]);
  assert.equal(r.rendered.length, 1);

  session.emit('turnStart', { speechId: 'sp2', turnId: 't2', isNewTurn: true });
  assert.equal(r.last, null);
  assert.equal(r.rendered.length, 0);

  session.emit('brainSegment', { metadata: { runtimeName: 'followups-tool' }, content: { questions: ['turn 2'] }, speechId: 'sp2' });
  session.emit('turnEnd', { speechId: 'sp2' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].data.questions, ['turn 2']);
  assert.equal(r.rendered.length, 1);   // turn 1's descriptor never lingers
});

test('ExperienceRenderer LIVE mode default: turnStart discards an in-flight (not-yet-flushed) buffer, not just rendered history', () => {
  const session = new FakeSession();
  const out = [];
  new ExperienceRenderer({ session, mount: (d) => out.push(d) }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'summary-tool' }, content: 'partial from turn 1', speechId: 'sp1' });
  session.emit('turnStart', { speechId: 'sp2', turnId: 't2', isNewTurn: true });
  session.emit('brainSegment', { metadata: { runtimeName: 'summary-tool' }, content: 'turn 2 body', speechId: 'sp2' });
  session.emit('turnEnd', { speechId: 'sp2' });
  assert.equal(out.length, 1);
  assert.match(out[0].data.summary, /turn 2 body/);
});

test('ExperienceRenderer { clearOnTurnStart:false } preserves cross-turn accumulation exactly as before issue #28', () => {
  const session = new FakeSession();
  const out = [];
  const r = new ExperienceRenderer({ session, mount: (d) => out.push(d), clearOnTurnStart: false }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'followups-tool' }, content: { questions: ['turn 1'] }, speechId: 'sp1' });
  session.emit('turnEnd', { speechId: 'sp1' });
  session.emit('turnStart', { speechId: 'sp2', turnId: 't2', isNewTurn: true });
  assert.equal(r.rendered.length, 1);   // NOT cleared
  assert.equal(r.last, out[0]);

  session.emit('brainSegment', { metadata: { runtimeName: 'followups-tool' }, content: { questions: ['turn 2'] }, speechId: 'sp2' });
  session.emit('turnEnd', { speechId: 'sp2' });
  assert.equal(out.length, 2);
  assert.equal(r.rendered.length, 2);   // accumulated across both turns
});

test('ExperienceRenderer: turnStart is a harmless no-op with no session (never subscribed, never throws)', () => {
  const r = new ExperienceRenderer();
  assert.doesNotThrow(() => r.start());
});

// ─────────────────────────── render(segment) single-arg path ───────────────────────────

test('render(segment) single-arg object form has parity with the two-arg string form', () => {
  const r = new ExperienceRenderer();
  const a = r.render('summary-tool', { summary: 'hi' });
  const b = r.render({ metadata: { runtimeName: 'summary-tool' }, content: { summary: 'hi' } });
  assert.equal(b.kind, a.kind);
  assert.equal(b.runtime, 'summary');
  assert.equal(b.runtimeName, 'summary-tool');
  assert.equal(b.data.summary, 'hi');
  // flattened headless feed + alias runtimeName key
  const c = r.render({ runtimeName: 'followups', content: { questions: ['q'] } });
  assert.equal(c.kind, 'followups');
  assert.deepEqual(c.data.questions, ['q']);
});

// ─────────────────────────── assembler edges ───────────────────────────

test('SegmentAssembler: object fragment wins over a later string fragment (documented rule)', () => {
  const got = [];
  const a = new SegmentAssembler({ onWidget: (w) => got.push(w) });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: { summary: 'OBJ' }, speechId: 's1' });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'ignored string', speechId: 's1' });
  a.flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].model.summary, 'OBJ');   // object body wins; the string is dropped
});

test('SegmentAssembler: speech_id snake_case alias buffers; two speechIds flush the first', () => {
  const got = [];
  const a = new SegmentAssembler({ onWidget: (w) => got.push(w) });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'a', speech_id: 'x1' });
  a.ingest({ metadata: { runtimeName: 'summary-tool' }, content: 'b', speech_id: 'x2' });   // new speechId → flush first
  assert.equal(got.length, 1);
  assert.equal(got[0].model.raw || got[0].model.summary || '', 'a');
  assert.equal(got[0].speechId, 'x1');
});

test('ExperienceRenderer LIVE: avatarStopTalking flushes the in-flight buffer', () => {
  const session = new FakeSession();
  const out = [];
  new ExperienceRenderer({ session, mount: (d) => out.push(d) }).start();
  session.emit('brainSegment', { metadata: { runtimeName: 'summary-tool' }, content: { summary: 'live' }, speechId: 'sp' });
  assert.equal(out.length, 0);            // buffered, not yet flushed
  session.emit('avatarStopTalking', {});
  assert.equal(out.length, 1);
  assert.equal(out[0].data.summary, 'live');
});

// ─────────────────────────── registry-derived known + contract ───────────────────────────

test('a registered 10th runtime is known:true (registry-derived) but firstClass:false', () => {
  const r = new ExperienceRenderer({ renderers: { 'gen-ui-composer': (m) => ({ kind: 'gen-ui-composer', data: m }) } });
  const d = r.render('gen-ui-composer-tool', { x: 1 });
  assert.equal(d.kind, 'gen-ui-composer');
  assert.equal(d._meta.known, true);        // this instance has a renderer for it
  assert.equal(d._meta.firstClass, false);  // not one of the built-in nine
  // a truly-unknown runtime stays known:false
  assert.equal(r.render('totally-unknown', {})._meta.known, false);
});

test('RUNTIMES (the 9 genie tools) are a subset of the registry; WIDGET_KINDS covers all + unknown/error', async () => {
  const { WIDGET_KINDS } = await import('../../src/experience/genui/renderers/index.js');
  for (const rt of RUNTIMES) assert.ok(Object.keys(DEFAULT_RENDERERS).includes(rt), `${rt} registered`);
  assert.ok(WIDGET_KINDS.includes('unknown') && WIDGET_KINDS.includes('error'));
  for (const k of Object.keys(DEFAULT_RENDERERS)) assert.ok(WIDGET_KINDS.includes(k));
});

// ─────────────────────────── adversarial totality + pollution ───────────────────────────

test('every default renderer is total over adversarial models (never throws, always {kind,data})', () => {
  const garbage = [null, undefined, 42, 'x', true, { cards: 'notarray' }, { items: [null, 1, true, {}] }, { a: { b: { c: {} } } }];
  for (const [name, fn] of Object.entries(DEFAULT_RENDERERS)) {
    for (const model of garbage) {
      let out;
      assert.doesNotThrow(() => { out = fn(model, {}); }, `${name} threw on ${JSON.stringify(model)}`);
      assert.equal(typeof out.kind, 'string');
      assert.equal(typeof out.data, 'object');
    }
  }
});

test('parseContent does not pollute Object.prototype from a __proto__ payload', () => {
  const m = parseContent('{"__proto__":{"polluted":1},"summary":"x"}');
  assert.equal(({}).polluted, undefined);          // global prototype intact
  assert.equal(m.summary, 'x');
  assert.equal(m.polluted, undefined);             // not an inherited key on the model
});

test('non-string url is treated as untrusted text by show-link (documents the coercion)', () => {
  const d = new ExperienceRenderer().render('show-link', { url: 12345, label: 'n' });
  assert.equal(typeof d.data.url, 'string');       // coerced, never a number reaching an href
});

// ─────────────────────────── mountWidget → safe DOM ───────────────────────────

// A minimal zero-dep DOM stub: enough for mountWidget's createElement/textContent/append path.
function fakeDom() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), nodeType: 1, children: [], attrs: {}, _text: '',
      dataset: {}, style: {}, hidden: false, _cls: '',
      classList: { _o: null, add(...c) { c.forEach((x) => { if (!(' ' + this._o._cls + ' ').includes(' ' + x + ' ')) this._o._cls = (this._o._cls + ' ' + x).trim(); }); }, contains(c) { return (' ' + this._o._cls + ' ').includes(' ' + c + ' '); } },
      set className(v) { this._cls = String(v); },
      get className() { return this._cls || ''; },
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); return c; }, append(...cs) { cs.forEach((c) => this.children.push(c)); },
      replaceChildren(...cs) { this.children = cs; }, addEventListener() {}, querySelector() { return null; },
    };
    node.classList._o = node;   // link classList back to its node so add()/contains() see _cls
    return node;
  };
  return { createElement: make, createTextNode: (s) => ({ nodeType: 3, tagName: '#text', children: [], textContent: String(s) }) };
}
function walk(node, fn) { fn(node); (node.children || []).forEach((c) => walk(c, fn)); }

test('mountWidget returns null without a DOM (isomorphic)', async () => {
  const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
  const had = typeof globalThis.document;
  assert.equal(had, 'undefined');                  // node test env has no document
  assert.equal(mountWidget({ kind: 'summary', data: { summary: 'x' } }, null), null);
});

test('mountWidget returns null (mounts nothing) when a builder appends no content — e.g. an empty summary', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const target = document.createElement('div');
    target.appendChild(document.createElement('span'));   // pre-existing content
    const root = mountWidget({ kind: 'summary', data: {} }, target, { replace: true });
    assert.equal(root, null);                    // nothing to mount
    assert.equal(target.children.length, 0);     // `replace:true` still clears stale content
  } finally { delete globalThis.document; }
});

test('mountWidget builds safe DOM for each kind; never an unsafe href/attr; unknown→fallback', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const samples = {
      summary: { summary: 'S', bullets: ['b'] },
      flashcards: { cards: [{ front: 'F', back: 'B', label: 'F' }] },
      followups: { questions: ['Q'] },
      sources: { sources: [{ title: 'T', url: 'javascript:evil()', snippet: 'sn' }] },
      'show-link': { url: 'javascript:evil()', label: '<img onerror=x>', safe: false },
      'external-video': { url: 'https://y.com/v', title: 'V', safe: true },
      'video-gallery': { videos: [{ entryId: '1_a', title: 'V', thumbnailUrl: 'https://k/i.png', alt: 'V' }] },
      'content-gallery': { items: [{ title: 'C', imageUrl: 'https://k/i.png', alt: 'C' }] },
      'user-properties-form': { fields: [{ key: 'email', type: 'email', label: 'Email', required: true }] },
    };
    for (const [kind, data] of Object.entries(samples)) {
      const root = mountWidget({ kind, data }, document.createElement('div'));
      assert.ok(root, `${kind} mounted`);
      assert.ok(root.className.includes('kgenui'));
      // no node carries a javascript: href/src anywhere
      walk(root, (n) => {
        if (n.attrs && n.attrs.href) assert.ok(!/^javascript:/i.test(n.attrs.href), `${kind} href safe`);
        if (n.attrs && n.attrs.src) assert.ok(!/^javascript:/i.test(n.attrs.src), `${kind} src safe`);
      });
    }
    // unsafe show-link drops the link entirely (no href node)
    const sl = mountWidget({ kind: 'show-link', data: { url: 'javascript:e()', safe: false } }, document.createElement('div'));
    let hrefs = 0; walk(sl, (n) => { if (n.attrs && n.attrs.href) hrefs++; });
    assert.equal(hrefs, 0);
    // unknown kind → visible fallback, never throws
    const unk = mountWidget({ kind: 'mystery', data: {} }, document.createElement('div'));
    assert.ok(unk.className.includes('kgenui--unknown'));
  } finally { delete globalThis.document; }
});

test('mountWidget external-video renders a real <iframe> for an embed host; link for others', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    // embeddable host → an <iframe> with the safe embed src, no javascript: anywhere
    const yt = mountWidget({ kind: 'external-video', data: { embedUrl: 'https://www.youtube-nocookie.com/embed/abc123', title: 'Clip', safe: true } }, document.createElement('div'));
    let iframe = null; walk(yt, (n) => { if (n.tagName === 'IFRAME') iframe = n; });
    assert.ok(iframe, 'iframe rendered for embed host');
    assert.equal(iframe.attrs.src, 'https://www.youtube-nocookie.com/embed/abc123');
    assert.equal(iframe.getAttribute('allowfullscreen'), '');
    // a NON-embed host must NOT iframe (defense-in-depth host allow-list) → falls back to a link
    const evil = mountWidget({ kind: 'external-video', data: { embedUrl: 'https://evil.com/embed/x', url: 'https://evil.com/x', title: 'X', safe: true } }, document.createElement('div'));
    let evilFrame = 0; walk(evil, (n) => { if (n.tagName === 'IFRAME') evilFrame++; });
    assert.equal(evilFrame, 0, 'no iframe for a non-allow-listed host');
  } finally { delete globalThis.document; }
});

test('mountWidget onMount enhancement seam fires after build; a throwing one leaves safe DOM', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    // onMount receives (root, descriptor) AFTER the safe subtree exists — works for any kind,
    // including a custom/unregistered one (a host-registered renderer or a hand-built descriptor).
    let seenRoot = null;
    let seen = null;
    const root = mountWidget({ kind: 'custom-widget', data: { title: 'T' } }, document.createElement('div'), {
      onMount: (r, d) => { seenRoot = r; seen = { kind: d.kind }; },
    });
    assert.equal(seen.kind, 'custom-widget');
    assert.equal(seenRoot, root);                       // same root Element passed in
    assert.equal(root.dataset.kind, 'custom-widget');
    // a throwing onMount must NOT break the mount — the safe fallback DOM stays
    let stillThere = false;
    assert.doesNotThrow(() => {
      const r2 = mountWidget({ kind: 'summary', data: { summary: 'y=2' } }, document.createElement('div'), { onMount: () => { throw new Error('lib boom'); } });
      walk(r2, (n) => { if (n._text === 'y=2') stillThere = true; });
    });
    assert.equal(stillThere, true);
  } finally { delete globalThis.document; }
});

test('mountWidget form submit + followup click fire onAction', async () => {
  globalThis.document = fakeDom();
  // capture listeners so we can invoke them
  const listeners = [];
  const baseMake = fakeDom().createElement;
  globalThis.document = { createElement: (t) => { const n = baseMake(t); n.addEventListener = (ev, fn) => listeners.push({ node: n, ev, fn }); return n; } };
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    mountWidget({ kind: 'followups', data: { questions: ['Why?'] } }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    const click = listeners.find((l) => l.ev === 'click'); assert.ok(click);
    click.fn();
    assert.equal(actions[0][0], 'followup');
    assert.equal(actions[0][1].question, 'Why?');
  } finally { delete globalThis.document; }
});

// ─────────────────────────── issue #27: markdown renderer ───────────────────────────

function textOf(node) { return node.textContent; }
function findAll(root, pred) { const hits = []; walk(root, (n) => { if (pred(n)) hits.push(n); }); return hits; }

test('renderSummary preserves newlines (safeSource, not safeText) so markdown structure survives', async () => {
  const { renderSummary } = await import('../../src/experience/genui/renderers/summary.js');
  const d = renderSummary({ summary: '# Title\n\n- a\n- b' });
  assert.equal(d.data.summary, '# Title\n\n- a\n- b');
});

test('mountWidget default (no markdown option): summary stays flat text, no markdown parsing', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const root = mountWidget({ kind: 'summary', data: { summary: '# Heading\n**bold**' } }, document.createElement('div'));
    const headings = findAll(root, (n) => /^H[1-6]$/.test(n.tagName || ''));
    assert.equal(headings.length, 0);              // no markdown heading parsed
    assert.ok(textOf(root).includes('# Heading'));  // raw markdown shown as flat text
  } finally { delete globalThis.document; }
});

test('mountWidget {markdown:true}: headings, bold/italic, inline code, links render as real DOM', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const summary = '## Q2 Results\n\nRevenue was **up** and *strong*, per `docs`. See [investor site](https://example.com/ir).';
    const root = mountWidget({ kind: 'summary', data: { summary } }, document.createElement('div'), { markdown: true });
    const h2 = findAll(root, (n) => n.tagName === 'H2'); assert.equal(h2.length, 1);
    assert.equal(textOf(h2[0]), 'Q2 Results');
    const strong = findAll(root, (n) => n.tagName === 'STRONG'); assert.equal(textOf(strong[0]), 'up');
    const em = findAll(root, (n) => n.tagName === 'EM'); assert.equal(textOf(em[0]), 'strong');
    const code = findAll(root, (n) => n.tagName === 'CODE' && n._cls && n._cls.includes('kgenui__md-code'));
    assert.equal(textOf(code[0]), 'docs');
    const a = findAll(root, (n) => n.tagName === 'A'); assert.equal(a.length, 1);
    assert.equal(a[0].href, 'https://example.com/ir');
    assert.equal(textOf(a[0]), 'investor site');
    assert.equal(a[0].rel, 'noopener noreferrer');
  } finally { delete globalThis.document; }
});

test('mountWidget {markdown:true}: a GFM table renders via the same safe tableEl builder', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const summary = '| Quarter | Revenue |\n| --- | --- |\n| Q1 | $10M |\n| Q2 | $12M |';
    const root = mountWidget({ kind: 'summary', data: { summary } }, document.createElement('div'), { markdown: true });
    const table = findAll(root, (n) => n.tagName === 'TABLE'); assert.equal(table.length, 1);
    const ths = findAll(table[0], (n) => n.tagName === 'TH').map(textOf);
    assert.deepEqual(ths, ['Quarter', 'Revenue']);
    const tds = findAll(table[0], (n) => n.tagName === 'TD').map(textOf);
    assert.deepEqual(tds, ['Q1', '$10M', 'Q2', '$12M']);
  } finally { delete globalThis.document; }
});

test('mountWidget {markdown:true}: lists (unordered + ordered) and fenced code blocks render', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const summary = '- one\n- two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```';
    const root = mountWidget({ kind: 'summary', data: { summary } }, document.createElement('div'), { markdown: true });
    const ul = findAll(root, (n) => n.tagName === 'UL' && n._cls && n._cls.includes('kgenui__md-list'));
    assert.equal(ul.length, 1);
    assert.deepEqual(findAll(ul[0], (n) => n.tagName === 'LI').map(textOf), ['one', 'two']);
    const ol = findAll(root, (n) => n.tagName === 'OL'); assert.equal(ol.length, 1);
    assert.deepEqual(findAll(ol[0], (n) => n.tagName === 'LI').map(textOf), ['first', 'second']);
    const pre = findAll(root, (n) => n.tagName === 'PRE'); assert.equal(pre.length, 1);
    assert.ok(textOf(pre[0]).includes('const x = 1;'));
  } finally { delete globalThis.document; }
});

test('mountWidget {markdown:true}: a javascript: link and a raw <script> tag are neutralized', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const summary = 'Click [here](javascript:alert(1)) or read <script>alert(2)</script> now.';
    const root = mountWidget({ kind: 'summary', data: { summary } }, document.createElement('div'), { markdown: true });
    const anchors = findAll(root, (n) => n.tagName === 'A');
    assert.equal(anchors.length, 0);                          // unsafe scheme → no <a> at all
    assert.ok(textOf(root).includes('here'));                 // label survives as plain text
    const scripts = findAll(root, (n) => n.tagName === 'SCRIPT');
    assert.equal(scripts.length, 0);                          // never parsed as an element — inert text
    assert.ok(textOf(root).includes('<script>alert(2)</script>'));
  } finally { delete globalThis.document; }
});

test('mountWidget {markdown:true}: an unrecognized/malformed line degrades to a plain paragraph, never throws', async () => {
  globalThis.document = fakeDom();
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    assert.doesNotThrow(() => mountWidget({ kind: 'summary', data: { summary: '' } }, document.createElement('div'), { markdown: true }));
    const root = mountWidget({ kind: 'summary', data: { summary: 'just some ``` unterminated fence text' } }, document.createElement('div'), { markdown: true });
    assert.ok(root);
  } finally { delete globalThis.document; }
});

test('renderMarkdown is isomorphic-gated by mountWidget (no document → mountWidget returns null, never throws)', async () => {
  const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
  assert.equal(mountWidget({ kind: 'summary', data: { summary: '# x' } }, null, { markdown: true }), null);
});

// ─────────────────────────── issue #39: graded-question widget ───────────────────────────
// NOT one of the nine backend runtimes — a host-registered "10th runtime" widget
// (see the "registry-derived known + contract" section above). renderGradedQuestion
// is imported directly (never through DEFAULT_RENDERERS/WIDGET_KINDS), and mountWidget
// dispatches on descriptor.kind alone, so BUILDERS['graded-question'] is reachable
// whether or not the host ever registers the runtime with an ExperienceRenderer.

test('renderGradedQuestion: choice variant shape when options are present', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const d = renderGradedQuestion({
    questionId: 'q1', prompt: 'Pick the primary color', options: [{ id: 'r', text: 'Red' }, { id: 'g', text: 'Green' }],
    correctOptionId: 'r', explanation: 'Red is primary.',
  });
  assert.equal(d.kind, 'graded-question');
  assert.deepEqual(d.data, {
    questionId: 'q1', variant: 'choice', prompt: 'Pick the primary color',
    options: [{ id: 'r', text: 'Red' }, { id: 'g', text: 'Green' }],
    correctOptionId: 'r', acceptedAnswers: [], explanation: 'Red is primary.',
  });
});

test('renderGradedQuestion: free-text variant shape when no options are given', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const d = renderGradedQuestion({ questionId: 'q2', prompt: 'Name the capital of France', acceptedAnswers: ['Paris', 'paris, france'] });
  assert.equal(d.data.variant, 'text');
  assert.deepEqual(d.data.options, []);
  assert.equal(d.data.correctOptionId, null);
  assert.deepEqual(d.data.acceptedAnswers, ['Paris', 'paris, france']);
});

test('renderGradedQuestion: no answer key authored → correctOptionId/acceptedAnswers stay empty (nullable, honest "ungraded" signal)', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const choice = renderGradedQuestion({ prompt: 'Open-ended', options: [{ id: 'a', text: 'A' }] });
  assert.equal(choice.data.correctOptionId, null);
  const text = renderGradedQuestion({ prompt: 'Open-ended' });
  assert.deepEqual(text.data.acceptedAnswers, []);
});

test('renderGradedQuestion: a correctOptionId that names no real option is dropped, not trusted blindly', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const d = renderGradedQuestion({ prompt: 'P', options: [{ id: 'a', text: 'A' }], correctOptionId: 'not-an-option' });
  assert.equal(d.data.correctOptionId, null);
});

test('renderGradedQuestion: options are capped at 8 (issue #39 rule 4.1)', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const options = Array.from({ length: 50 }, (_, i) => ({ id: 'o' + i, text: 'Option ' + i }));
  const d = renderGradedQuestion({ prompt: 'P', options });
  assert.equal(d.data.options.length, 8);
});

test('renderGradedQuestion is total over adversarial models (never throws, always {kind,data})', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const garbage = [null, undefined, 42, 'x', true, { options: 'notarray' }, { options: [null, 1, true, {}] }, { a: { b: { c: {} } } }];
  for (const model of garbage) {
    let out;
    assert.doesNotThrow(() => { out = renderGradedQuestion(model); }, `renderGradedQuestion threw on ${JSON.stringify(model)}`);
    assert.equal(out.kind, 'graded-question');
    assert.equal(typeof out.data, 'object');
  }
});

test('renderGradedQuestion returns fresh descriptors with no shared references across calls (issue #39 rule 1.1)', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const a = renderGradedQuestion({ prompt: 'A', options: [{ id: '1', text: 'one' }] });
  const b = renderGradedQuestion({ prompt: 'B', options: [{ id: '1', text: 'one' }] });
  assert.notEqual(a, b);
  assert.notEqual(a.data, b.data);
  assert.notEqual(a.data.options, b.data.options);
  a.data.options.push({ id: 'x', text: 'mutated' });
  assert.equal(b.data.options.length, 1);   // mutating one output's arrays never affects the other
});

test('a host-registered graded-question runtime is known:true but firstClass:false (same 10th-runtime seam as any custom widget)', async () => {
  const { renderGradedQuestion } = await import('../../src/experience/genui/renderers/graded-question.js');
  const r = new ExperienceRenderer({ renderers: { 'graded-question': renderGradedQuestion } });
  const d = r.render('graded-question', { prompt: 'P', options: [{ id: 'a', text: 'A' }] });
  assert.equal(d.kind, 'graded-question');
  assert.equal(d._meta.known, true);
  assert.equal(d._meta.firstClass, false);
});

/** Wraps fakeDom() so every created node's addEventListener pushes {node, ev, fn} into `listeners`, mirroring the existing 'mountWidget form submit + followup click fire onAction' test's pattern. */
function listenerCapturingDom(listeners) {
  const baseMake = fakeDom().createElement;
  return { createElement: (t) => { const n = baseMake(t); n.addEventListener = (ev, fn) => listeners.push({ node: n, ev, fn }); return n; } };
}

test('mountWidget graded-question (choice): selecting the correct option fires onAction("answer", ...) with the documented shape', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    const data = { questionId: 'q1', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'b', explanation: 'because b' };
    mountWidget({ kind: 'graded-question', data }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    const radios = listeners.filter((l) => l.ev === 'change');
    assert.equal(radios.length, 2);
    radios[1].fn();                                   // select option 'b' (the correct one)
    const clicks = listeners.filter((l) => l.ev === 'click');
    assert.equal(clicks.length, 1);
    clicks[0].fn();                                    // submit
    assert.equal(actions.length, 1);
    const [action, payload] = actions[0];
    assert.equal(action, 'answer');
    assert.deepEqual(payload, { questionId: 'q1', variant: 'choice', correct: true, value: 'B', explanation: 'because b', optionId: 'b' });
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (choice): a wrong selection reports correct:false; no correctOptionId reports correct:null; unanswered submit is a no-op', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    const data = { questionId: 'q1', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'b' };
    mountWidget({ kind: 'graded-question', data }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    const clicks = listeners.filter((l) => l.ev === 'click');
    clicks[0].fn();                                    // submit with no selection made yet
    assert.equal(actions.length, 0, 'a submit with no selection is a no-op, never a false-graded answer');
    listeners.filter((l) => l.ev === 'change')[0].fn();  // select the wrong option 'a'
    clicks[0].fn();
    assert.equal(actions.length, 1);
    assert.equal(actions[0][1].correct, false);
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (choice): with no correctOptionId authored, correct is null (honest "ungraded"), never false', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    mountWidget({ kind: 'graded-question', data: { questionId: 'q1', options: [{ id: 'a', text: 'A' }] } }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    listeners.filter((l) => l.ev === 'change')[0].fn();
    listeners.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actions[0][1].correct, null);
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (text): the free-text answer is sanitized before grading AND before any DOM insertion (issue #39 rule 2.2)', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    const data = { questionId: 'q2', prompt: 'Name the capital', acceptedAnswers: ['Paris'], explanation: 'It is Paris.' };
    const root = mountWidget({ kind: 'graded-question', data }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    const inputListener = listeners.find((l) => l.ev === 'input');
    assert.ok(inputListener);
    inputListener.node.value = 'Par\x00is\x07<script>alert(1)</script>';
    inputListener.fn();
    listeners.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actions.length, 1);
    const [action, payload] = actions[0];
    assert.equal(action, 'answer');
    // control chars stripped by safeText; the <script> text survives only as inert text, never a parsed element
    assert.equal(payload.value, 'Paris<script>alert(1)</script>');
    assert.equal(payload.correct, false);   // sanitized value != 'paris' exactly → gradeable, never a crash
    let scriptTags = 0, sawEcho = false;
    walk(root, (n) => {
      if (n.tagName === 'SCRIPT') scriptTags++;
      if (n._cls && n._cls.includes('kgenui__answer-echo')) {
        sawEcho = true;
        // eslint-disable-next-line no-control-regex -- asserting control chars are ABSENT, not a lint mistake
        assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(n.textContent));
      }
    });
    assert.equal(scriptTags, 0, 'never a parsed <script> element — textContent only, never innerHTML');
    assert.ok(sawEcho, 'the sanitized answer is echoed back into the DOM');
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (choice): the options list sits inside a <fieldset>/<legend> naming the question, not a bare list', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const data = { questionId: 'q1', prompt: 'Pick the capital of France', options: [{ id: 'a', text: 'Paris' }, { id: 'b', text: 'Rome' }] };
    const root = mountWidget({ kind: 'graded-question', data }, document.createElement('div'));
    let fieldset = null, legend = null;
    walk(root, (n) => {
      if (n.tagName === 'FIELDSET') fieldset = n;
      if (n.tagName === 'LEGEND') legend = n;
    });
    assert.ok(fieldset, 'the radiogroup is wrapped in a <fieldset>');
    assert.ok(legend, 'the <fieldset> has a <legend>');
    assert.ok(fieldset.children.includes(legend), 'the <legend> belongs to the <fieldset>, not a sibling');
    assert.equal(legend.textContent, data.prompt, 'the legend names the question so the radiogroup has an accessible group name');
    assert.ok(legend.className.includes('kgenui__sr-only'), 'the legend is screen-reader-only — the prompt is already shown visibly above');
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question: the role="status" feedback region is mounted (present, not hidden) before any answer, so AT can announce its later update', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const data = { questionId: 'q1', options: [{ id: 'a', text: 'A' }], correctOptionId: 'a' };
    const root = mountWidget({ kind: 'graded-question', data }, document.createElement('div'));
    let feedback = null;
    walk(root, (n) => { if (n.className && n.className.includes('kgenui__feedback')) feedback = n; });
    assert.ok(feedback, 'the feedback element exists in the DOM before any answer is submitted');
    assert.equal(feedback.hidden, false, 'never `.hidden` from mount — a hidden element is pulled from the a11y tree, defeating role="status"');
    assert.equal(feedback.getAttribute('role'), 'status');
    assert.equal(feedback.textContent, '', 'empty until answered — presence, not content, is what must exist upfront');
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (text): pressing Enter in the answer input submits, same as clicking the button', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    const data = { questionId: 'q2', prompt: 'Name the capital', acceptedAnswers: ['Paris'] };
    mountWidget({ kind: 'graded-question', data }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    const inputListener = listeners.find((l) => l.ev === 'input');
    inputListener.node.value = 'Paris';
    inputListener.fn();
    const keydownListener = listeners.find((l) => l.ev === 'keydown');
    assert.ok(keydownListener, 'the input has a keydown listener for Enter-to-submit');
    keydownListener.fn({ key: 'Shift' });   // a non-Enter key must never submit
    assert.equal(actions.length, 0);
    keydownListener.fn({ key: 'Enter' });
    assert.equal(actions.length, 1);
    assert.equal(actions[0][1].correct, true);
  } finally { delete globalThis.document; }
});

test('mountWidget graded-question (text): no accepted answers authored → correct is null (honest "ungraded"), never false', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actions = [];
    mountWidget({ kind: 'graded-question', data: { questionId: 'q3', prompt: 'Reflect on this' } }, document.createElement('div'), { onAction: (a, p) => actions.push([a, p]) });
    listeners.find((l) => l.ev === 'input').node.value = 'my open-ended reflection';
    listeners.find((l) => l.ev === 'input').fn();
    listeners.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actions[0][1].correct, null);
  } finally { delete globalThis.document; }
});

test('two mounted graded-question widgets in one process never share selection/answered state (issue #39 rule 1.2)', async () => {
  const listeners = [];
  globalThis.document = listenerCapturingDom(listeners);
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const actionsA = [], actionsB = [];
    const shared = { options: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }] };

    const beforeA = listeners.length;
    mountWidget({ kind: 'graded-question', data: { ...shared, questionId: 'a', correctOptionId: 'x' } }, document.createElement('div'), { onAction: (a, p) => actionsA.push([a, p]) });
    const listenersA = listeners.slice(beforeA);

    const beforeB = listeners.length;
    mountWidget({ kind: 'graded-question', data: { ...shared, questionId: 'b', correctOptionId: 'y' } }, document.createElement('div'), { onAction: (a, p) => actionsB.push([a, p]) });
    const listenersB = listeners.slice(beforeB);

    // Answer only A (select its wrong option 'y') — B must be completely untouched.
    listenersA.filter((l) => l.ev === 'change')[1].fn();
    listenersA.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actionsA.length, 1);
    assert.equal(actionsA[0][1].correct, false);
    assert.equal(actionsB.length, 0, 'mounting/answering A never fires B\'s onAction');

    // B's submit with no selection is still a no-op — its own selection state was never set by A.
    listenersB.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actionsB.length, 0);

    // Now answer B correctly (select 'y', its correct option) — independent of A's already-answered state.
    listenersB.filter((l) => l.ev === 'change')[1].fn();
    listenersB.filter((l) => l.ev === 'click')[0].fn();
    assert.equal(actionsB.length, 1);
    assert.equal(actionsB[0][1].correct, true);
    assert.equal(actionsA.length, 1, 'B\'s answer never re-fires or mutates A\'s already-recorded action');
  } finally { delete globalThis.document; }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * Knowledge management — against the Kaltura Knowledge tab: an agent's
 * knowledge is a Kaltura category of media entries; "add a file" = ingest a
 * Kaltura entry and categoryEntry.add it to that category. These tests assert
 * the SDK produces that exact call sequence against a fake OVP.
 */
const ADMIN = { ks: 'djJ8' + Buffer.from('v2|6516742|x').toString('base64url'), kind: 'admin', entitlementEnforced: false };

test('getLinkage reads knowledge_ids + enabled flag from v1/intellect/get', async () => {
  const f = fakeFetch([{ match: '/v1/intellect/get', respond: () => ({ body: { id: 1481, knowledge_ids: [7, 42], capabilities: { use_knowledge_base: 'on' } } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const link = await m.knowledge.getLinkage(1481, ADMIN);
  assert.deepEqual(link.knowledgeIds, [7, 42]);
  assert.equal(link.enabled, true);
});

test('setEnabled toggles use_knowledge_base via Genie v1/intellect/update', async () => {
  const f = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 1481, type: 'internal', status: 2, capabilities: { avatar: 'on' } } }) },
    { match: '/v1/intellect/update', respond: (req) => ({ body: { id: 1481, capabilities: req.body.capabilities } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.setEnabled(1481, true, ADMIN);
  const call = f.calls.find((c) => c.url.includes('/v1/intellect/update'));
  assert.equal(call.body.capabilities.use_knowledge_base, 'on');
  assert.equal(call.body.type, 'internal');   // required discriminator
});

test('setEnabled merges the capabilities full-replace sub-dict (reuses mergeCapabilityWrite)', async () => {
  const f = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 1481, type: 'internal', status: 2, capabilities: { avatar: 'on', use_web_search: 'off' } } }) },
    { match: '/v1/intellect/update', respond: (req) => ({ body: { id: 1481, capabilities: req.body.capabilities } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.setEnabled(1481, true, ADMIN);
  const caps = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body.capabilities;
  // full-replace dict overlaid: siblings survive, target flipped — exactly mergeCapabilityWrite's contract
  assert.deepEqual(caps, { avatar: 'on', use_web_search: 'off', use_knowledge_base: 'on' });
});

test('REGRESSION: setEnabled preserves status + existing config (capabilities is the full-replace sub-dict; update is a PATCH)', async () => {
  // A naive partial capabilities dict DROPS sibling capabilities; the read-merge-write
  // (mergeCapabilityWrite) preserves them. status/prompts/base_directive are preserved
  // because update is a model_fields_set PATCH (we re-send them defensively).
  const full = { id: 1481, type: 'internal', status: 2, base_directive: 'You are Ron…', prompts: [{ key: 'name', value: 'Ron' }], glossary: 'KLTR…', capabilities: { avatar: 'on', avatar_filler: 'on' }, partner_id: 6516742, created_at: 'x', updated_at: 'y' };
  const f = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ body: full }) },
    { match: '/v1/intellect/update', respond: (req) => ({ body: req.body }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.setEnabled(1481, true, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.status, 2, 'status must stay ACTIVE');
  assert.equal(sent.base_directive, 'You are Ron…', 'base_directive preserved');
  assert.equal(sent.prompts.length, 1, 'prompts preserved');
  assert.equal(sent.glossary, 'KLTR…', 'glossary preserved');
  assert.equal(sent.capabilities.avatar, 'on', 'existing capabilities preserved');
  assert.equal(sent.capabilities.use_knowledge_base, 'on', 'only the target flag changed');
  // server-managed read-only fields must NOT be echoed back
  assert.ok(!('partner_id' in sent) && !('created_at' in sent) && !('updated_at' in sent));
});

test('uploadDocument runs the 4-step flow: entry+token → upload → addContent+categoryEntry', async () => {
  const seen = [];
  const f = fakeFetch([
    { match: '/service/multirequest', respond: (req) => {
        seen.push(req.body);
        // first multirequest = baseentry.add + uploadtoken.add
        if (req.body['0']?.service === 'baseentry') return { body: [{ id: '1_newdoc' }, { id: '1_tok' }] };
        // second = addContent + categoryEntry.add
        return { body: [{ id: '1_newdoc' }, { categoryId: 408750172, entryId: '1_newdoc' }] };
      } },
    { match: '/uploadtoken/action/upload', respond: () => ({ body: { id: '1_tok', fileName: 'deck.pdf' } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' });
  const r = await m.knowledge.uploadDocument({ file, name: 'deck.pdf', categoryId: 408750172 }, ADMIN);
  assert.equal(r.entryId, '1_newdoc');
  assert.equal(r.categoryId, 408750172);
  // step 1: a document entry was created
  assert.equal(seen[0]['0'].entry.objectType, 'KalturaDocumentEntry');
  assert.equal(seen[0]['0'].entry.documentType, 11);
  // step 3: the entry was assigned to the knowledge category (the actual "attach")
  assert.equal(seen[1]['1'].service, 'categoryentry');
  assert.equal(seen[1]['1'].categoryEntry.categoryId, 408750172);
  assert.equal(seen[1]['1'].categoryEntry.entryId, '1_newdoc');
  // the file bytes were uploaded to the token
  assert.ok(f.calls.some((c) => c.url.includes('/uploadtoken/action/upload')));
});

test('uploadMarkdown creates the entry, links it, then attaches a KalturaMarkdownAsset via a separate token', async () => {
  const seen = { multi: [], addTokens: 0 };
  const f = fakeFetch([
    { match: '/service/multirequest', respond: (req) => {
        seen.multi.push(req.body);
        // first multirequest = baseentry.add + uploadtoken.add (backing entry)
        if (req.body['0']?.service === 'baseentry' && req.body['0']?.action === 'add') return { body: [{ id: '1_md' }, { id: '1_entrytok' }] };
        // second = baseentry.updateContent + categoryentry.add
        return { body: [{ id: '1_md' }, { categoryId: 413804062, entryId: '1_md' }] };
      } },
    { match: '/uploadtoken/action/upload', respond: () => ({ body: { id: '1_assettok', fileName: 'facts.md' } }) },
    { match: '/service/uploadtoken/action/add', respond: () => { seen.addTokens += 1; return { body: { id: '1_assettok' } }; } },
    { match: '/service/attachment_attachmentasset/action/add', respond: () => ({ body: { id: '1_asset', objectType: 'KalturaMarkdownAsset' } }) },
    { match: '/service/attachment_attachmentasset/action/setContent', respond: () => ({ body: { id: '1_asset' } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.knowledge.uploadMarkdown({ markdown: '# Facts\n\nRevenue was $1.\n', name: 'facts.md', categoryId: 413804062 }, ADMIN);
  assert.equal(r.entryId, '1_md');
  assert.equal(r.categoryId, 413804062);
  assert.equal(r.markdownAssetId, '1_asset');
  // backing entry: a document entry, not a PDF-conversion dependency
  assert.equal(seen.multi[0]['0'].entry.objectType, 'KalturaDocumentEntry');
  // linked into the category
  assert.equal(seen.multi[1]['1'].service, 'categoryentry');
  assert.equal(seen.multi[1]['1'].categoryEntry.categoryId, 413804062);
  // a SEPARATE upload token was minted for the markdown asset (not reusing the entry's token)
  assert.equal(seen.addTokens, 1);
  // the attachment itself is the markdown asset the indexer scans for
  assert.ok(f.calls.some((c) => c.url.includes('/attachment_attachmentasset/action/add')));
  assert.ok(f.calls.some((c) => c.url.includes('/attachment_attachmentasset/action/setContent')));
  // two independent upload passes happened (entry content + asset content)
  assert.equal(f.calls.filter((c) => c.url.includes('/uploadtoken/action/upload')).length, 2);
});

test('uploadMarkdown tolerates a duplicate categoryentry.add (transport retry re-ran an applied multirequest)', async () => {
  const f = fakeFetch([
    { match: '/service/multirequest', respond: (req) => {
        if (req.body['0']?.service === 'baseentry' && req.body['0']?.action === 'add') return { body: [{ id: '1_md' }, { id: '1_entrytok' }] };
        // the retried second multirequest: updateContent fine, categoryentry.add reports the pair as already linked
        return { body: [{ id: '1_md' }, { objectType: 'KalturaAPIException', code: 'CATEGORY_ENTRY_ALREADY_EXISTS', message: 'Entry already assigned to this category' }] };
      } },
    { match: '/uploadtoken/action/upload', respond: () => ({ body: { id: '1_tok' } }) },
    { match: '/service/uploadtoken/action/add', respond: () => ({ body: { id: '1_assettok' } }) },
    { match: '/service/attachment_attachmentasset/action/add', respond: () => ({ body: { id: '1_asset', objectType: 'KalturaMarkdownAsset' } }) },
    { match: '/service/attachment_attachmentasset/action/setContent', respond: () => ({ body: { id: '1_asset' } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.knowledge.uploadMarkdown({ markdown: '# Facts\n', name: 'facts.md', categoryId: 413804062 }, ADMIN);
  // the flow continued past the duplicate and still attached the indexable markdown asset
  assert.equal(r.entryId, '1_md');
  assert.equal(r.markdownAssetId, '1_asset');
});

test('uploadMarkdown still throws on a REAL link-step exception (not a duplicate link)', async () => {
  const f = fakeFetch([
    { match: '/service/multirequest', respond: (req) => {
        if (req.body['0']?.service === 'baseentry' && req.body['0']?.action === 'add') return { body: [{ id: '1_md' }, { id: '1_entrytok' }] };
        return { body: [{ objectType: 'KalturaAPIException', code: 'UPLOAD_TOKEN_NOT_FOUND', message: 'Upload token not found' }, { categoryId: 413804062, entryId: '1_md' }] };
      } },
    { match: '/uploadtoken/action/upload', respond: () => ({ body: { id: '1_tok' } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.knowledge.uploadMarkdown({ markdown: '# Facts\n', name: 'facts.md', categoryId: 413804062 }, ADMIN),
    (e) => e.code === 'ovp_error' && e.title === 'UPLOAD_TOKEN_NOT_FOUND',
  );
});

test('uploadDocument surfaces a per-slot link-step exception (was silently passed) but tolerates a duplicate link', async () => {
  const multi = (linkSlot) => fakeFetch([
    { match: '/service/multirequest', respond: (req) => {
        if (req.body['0']?.service === 'baseentry') return { body: [{ id: '1_doc' }, { id: '1_tok' }] };
        return { body: [{ id: '1_doc' }, linkSlot] };
      } },
    { match: '/uploadtoken/action/upload', respond: () => ({ body: { id: '1_tok' } }) },
  ]);
  const file = new Blob([new Uint8Array([1])], { type: 'application/pdf' });
  // duplicate link → success
  const ok = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: multi({ objectType: 'KalturaAPIException', code: 'CATEGORY_ENTRY_ALREADY_EXISTS', message: 'Entry already assigned to this category' }) });
  const r = await ok.knowledge.uploadDocument({ file, name: 'deck.pdf', categoryId: 408750172 }, ADMIN);
  assert.equal(r.entryId, '1_doc');
  // real per-slot exception → throws (regression: the old check only caught a whole-request exception)
  const bad = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: multi({ objectType: 'KalturaAPIException', code: 'CATEGORY_NOT_FOUND', message: 'Category not found' }) });
  await assert.rejects(
    () => bad.knowledge.uploadDocument({ file, name: 'deck.pdf', categoryId: 408750172 }, ADMIN),
    (e) => e.code === 'ovp_error' && e.title === 'CATEGORY_NOT_FOUND',
  );
});

test('attachEntry resolves (not throws) when the pair is already linked — idempotent as documented', async () => {
  const f = fakeFetch([{ match: '/categoryentry/action/add', respond: () => ({ body: { objectType: 'KalturaAPIException', code: 'CATEGORY_ENTRY_ALREADY_EXISTS', message: 'Entry already assigned to this category' } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.knowledge.attachEntry('1_x', 5, ADMIN);
  assert.equal(r.categoryId, 5);
  assert.equal(r.entryId, '1_x');
});

test('attachEntry assigns an existing entry; detachEntry needs confirmation', async () => {
  const f = fakeFetch([{ match: '/categoryentry/action/add', respond: () => ({ body: { categoryId: 5, entryId: '1_x' } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.attachEntry('1_x', 5, ADMIN);
  assert.ok(f.calls.some((c) => c.url.includes('/categoryentry/action/add')));
  await assert.rejects(() => m.knowledge.detachEntry('1_x', 5, ADMIN), (e) => e.code === 'confirmation_required');
});

test('uploadDocument requires a categoryId (no silent no-op)', async () => {
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: fakeFetch([]) });
  const file = new Blob([new Uint8Array([1])], { type: 'application/pdf' });
  await assert.rejects(() => m.knowledge.uploadDocument({ file, name: 'x.pdf' }, ADMIN), (e) => e.code === 'bad_request');
});
test('linkCategory writes the VERIFIED categoryEntry indexer DTO (singular categoryId + indexer-level chunkSize) via partner-config/update', async () => {
  const f = fakeFetch([{ match: '/partner-config/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.knowledge.linkCategory({ configId: 1505, categoryId: 408750172 }, ADMIN);
  assert.equal(r.applied, true);   // succeeded (not gated) on the fake
  const call = f.calls.find((c) => c.url.includes('/partner-config/update'));
  const idx = call.body.config.indexer;
  assert.equal(call.body.id, 1505);
  assert.equal(idx.filterType, 'categoryEntry');
  // Backend reads category_info["categoryId"] (SINGULAR string) + ["language"] and
  // index_config["chunkSize"] at the indexer level.
  assert.equal(idx.categoryInfo[0].categoryId, '408750172');
  assert.equal(idx.categoryInfo[0].language, 'English');
  assert.equal(idx.chunkSize, 5000);      // backend default
  assert.ok(!('categoryIds' in idx.categoryInfo[0]), 'must NOT emit categoryIds[] — the indexer reads singular categoryId');
  assert.ok(!('objects' in idx.categoryInfo[0]), 'must NOT fabricate objects[]/indexPosition — the indexer never reads them');
  assert.equal(call.body.config.capabilities.use_knowledge_base, 'on');
});

test('linkCategory validates modalities pre-wire but does NOT send a fabricated objects[]; honors chunkSize', async () => {
  const f = fakeFetch([{ match: '/partner-config/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.linkCategory({ configId: 1505, categoryId: 7, modalities: ['ocr', 'document'], chunkSize: 2000 }, ADMIN);
  const idx = f.calls.find((c) => c.url.includes('/partner-config/update')).body.config.indexer;
  assert.equal(idx.chunkSize, 2000);
  assert.ok(!('objects' in idx.categoryInfo[0]), 'valid modalities accepted but not emitted as objects[]');
  // an UNKNOWN modality is still rejected BEFORE the wire (input validation preserved)
  await assert.rejects(() => m.knowledge.linkCategory({ configId: 1505, categoryId: 7, modalities: ['bogus'] }, ADMIN), /bad_request|modality/i);
});

test('linkCategory is GATED: a 403 returns {applied:false} and NEVER throws', async () => {
  const f = fakeFetch([{ match: '/partner-config/update', respond: () => ({ status: 403, body: { detail: '403 Forbidden' } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.knowledge.linkCategory({ configId: 1505, categoryId: 7 }, ADMIN);
  assert.equal(r.applied, false);
  assert.equal(r.code, 'forbidden');
  assert.match(r.reason, /privilege/);
});

test('createCategory hits OVP category/add at admin scope (NOT the gated linkage op)', async () => {
  const f = fakeFetch([{ match: '/service/category/action/add', respond: (req) => ({ body: { objectType: 'KalturaCategory', id: 99, name: req.body.category.name } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const cat = await m.knowledge.createCategory({ name: 'Agent KB', parentId: 5, description: 'corpus' }, ADMIN);
  assert.equal(cat.id, 99);
  const sent = f.calls.find((c) => c.url.includes('/service/category/action/add')).body;
  assert.equal(sent.category.objectType, 'KalturaCategory');
  assert.equal(sent.category.name, 'Agent KB');
  assert.equal(sent.category.parentId, 5);
});

test('createCategory rejects an empty name BEFORE the network call', async () => {
  const f = fakeFetch([]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.createCategory({ name: '' }, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('corpusStatus counts an explicit container categoryId via baseentry totalCount', async () => {
  const f = fakeFetch([{ match: '/service/baseentry/action/list', respond: () => ({ body: { objects: [], totalCount: 3 } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const st = await m.knowledge.corpusStatus({ categoryId: 408750172 }, ADMIN);
  assert.equal(st.entryCount, 3);
  assert.equal(st.populated, true);
  assert.deepEqual(st.categoryIds, [408750172]);
  assert.equal(st.perCategory[408750172], 3);
  assert.ok(st._meta.generatedAt, 'provenance receipt present');
  // a SINGLE list call per category (totalCount, no per-entry probe loop)
  assert.equal(f.calls.filter((c) => c.url.includes('/service/baseentry/action/list')).length, 1);
});

test('corpusStatus surfaces retrievalGated when configId linkage is empty/gated', async () => {
  const f = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 1505, knowledge_ids: [], capabilities: {} } }) },
    { match: '/service/baseentry/action/list', respond: () => ({ body: { objects: [], totalCount: 4 } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  // explicit container id counts (4), linkage is empty → gated flag set
  const st = await m.knowledge.corpusStatus({ configId: 1505, categoryId: 99 }, ADMIN);
  assert.equal(st.entryCount, 4);
  assert.equal(st.populated, true);
  assert.equal(st._meta.retrievalGated, true);
  assert.match(st._meta.reason, /gated|privilege/);
});

test('corpusStatus requires at least one of categoryId/categoryIds/configId', async () => {
  const f = fakeFetch([]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.corpusStatus({}, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('corpusStatus with ONLY a configId whose linkage is empty returns gated (does NOT throw)', async () => {
  // The real-world case: an in-use agent whose knowledge linkage is not on the read façade
  // (deployment-gated — see API-REFERENCE.md § Ground the Agent). corpusStatus must
  // report it honestly, not raise bad_request.
  const f = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 1507, knowledge_ids: [], capabilities: {} } }) },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const st = await m.knowledge.corpusStatus({ configId: 1507 }, ADMIN);
  assert.equal(st.populated, false);
  assert.equal(st.entryCount, 0);
  // retrievalGated/reason live in _meta (single stable place), not top-level.
  assert.equal(st._meta.retrievalGated, true);
  assert.match(st._meta.reason, /gated|privilege|linkage/i);
  assert.equal(st.retrievalGated, undefined, 'not duplicated at top-level');
  assert.deepEqual(st.categoryIds, []);
  assert.ok(st._meta.generatedAt, 'provenance receipt present');
  // No baseentry list call happens when there are no categories to count.
  assert.equal(f.calls.filter((c) => c.url.includes('/service/baseentry/action/list')).length, 0);
});

test('linkAvailable reports forbidden (deployment-gated) vs not_deployed vs available', async () => {
  const forbidden = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: fakeFetch([{ match: '/partner-config/get', respond: () => ({ status: 403, body: { detail: '403 Forbidden' } }) }]) });
  assert.deepEqual((await forbidden.knowledge.linkAvailable(ADMIN)).code, 'forbidden');
  const missing = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: fakeFetch([{ match: '/partner-config/get', respond: () => ({ status: 404, body: { detail: 'Not Found' } }) }]) });
  assert.deepEqual((await missing.knowledge.linkAvailable(ADMIN)).code, 'not_deployed');
  const ok = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: fakeFetch([{ match: '/partner-config/get', respond: () => ({ body: { id: 0, config: {} } }) }]) });
  assert.equal((await ok.knowledge.linkAvailable(ADMIN)).available, true);
});

test('linkRecords + addRecord + indexStatus hit the documented routes', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/add', respond: () => ({ body: { id: 7, config: { sources: [] } } }) },
    { match: '/partner-config/update', respond: (req) => ({ body: { config: req.body.config } }) },
    { match: '/partner-config/stats', respond: () => ({ body: { objects: [] } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const rec = await m.knowledge.addRecord({ name: 'kb' }, ADMIN);
  assert.equal(rec.id, 7);
  await m.knowledge.linkRecords(1505, [7], ADMIN);
  const link = f.calls.find((c) => c.url.includes('/partner-config/update'));
  assert.deepEqual(link.body.config.knowledge_ids, [7]);
  await m.knowledge.indexStatus(ADMIN);
  assert.ok(f.calls.some((c) => c.url.includes('/partner-config/stats')));
});

test('getRecord/updateRecord hit v1/knowledge/get|update with a validated integer id', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: (req) => ({ body: { id: req.body.id, name: 'kb', config: { sources: [] } } }) },
    { match: '/v1/knowledge/update', respond: (req) => ({ body: { id: req.body.id, name: req.body.name ?? 'kb', description: req.body.description } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.getRecord(/** @type {any} */ ('7'), ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.knowledge.updateRecord(7, {}, ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.knowledge.updateRecord(7, { name: '' }, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0, 'no transport before validation passes');

  const rec = await m.knowledge.getRecord(7, ADMIN);
  assert.equal(rec.id, 7);
  assert.deepEqual(f.calls[0].body, { id: 7 });

  const upd = await m.knowledge.updateRecord(7, { name: 'kb2', description: 'd2' }, ADMIN);
  assert.equal(upd.name, 'kb2');
  assert.deepEqual(f.calls[1].body, { id: 7, name: 'kb2', description: 'd2' });
});

test('isIndexed reads status+index_position off getRecord', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 2428, status: 'READY', config: { sources: [{ indexers: [{ index_position: 1786936785, type: 3, strategy: 'EmbedDocumentV1' }] }] } } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const st = await m.knowledge.isIndexed(2428, ADMIN);
  assert.deepEqual(st, { ready: true, status: 'READY', indexPosition: 1786936785 });
});

test('isIndexed reports not-ready for any non-READY status, with no indexers present', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 9, status: 'PENDING', config: { sources: [] } } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const st = await m.knowledge.isIndexed(9, ADMIN);
  assert.deepEqual(st, { ready: false, status: 'PENDING', indexPosition: null });
});

test('isIndexed skips a leading indexer with a null index_position and reports the next one that has it', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 3, status: 'READY', config: { sources: [
      { indexers: [{ index_position: null, type: 3, strategy: 'EmbedDocumentV1' }] },
      { indexers: [{ index_position: 42, type: 3, strategy: 'EmbedDocumentV1' }] },
    ] } } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const st = await m.knowledge.isIndexed(3, ADMIN);
  assert.deepEqual(st, { ready: true, status: 'READY', indexPosition: 42 });
});

test('entryStatus posts {knowledge_id, entry_ids} to v1/knowledge/entry_status and returns the raw {entries} array', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/entry_status', respond: () => ({ body: { entries: [
      { entry_id: '0_abc123', documents: [{ objectType: 'KalturaMarkdownAsset', objectId: '0_abc123', status: 'SUCCEEDED' }] },
    ] } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.entryStatus(2428, ['0_abc123', 'unknown-id'], ADMIN);
  assert.deepEqual(res, { entries: [
    { entry_id: '0_abc123', documents: [{ objectType: 'KalturaMarkdownAsset', objectId: '0_abc123', status: 'SUCCEEDED' }] },
  ] });
  assert.deepEqual(f.calls[0].body, { knowledge_id: 2428, entry_ids: ['0_abc123', 'unknown-id'] });
});

test('entryStatus rejects a bad knowledgeId or entryIds before any network call', async () => {
  const f = fakeFetch([]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.entryStatus(-1, ['x'], ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.knowledge.entryStatus(2428, [], ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.knowledge.entryStatus(2428, Array.from({ length: 501 }, (_, i) => `id${i}`), ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.knowledge.entryStatus(2428, [123], ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0, 'no write on any validation failure');
});

test('deleteRecord requires confirmPermanent, scans for references, posts v1/knowledge/delete, and returns a {removed,_meta} receipt (wire body is null)', async () => {
  const f = fakeFetch([
    { match: '/v1/intellect/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: '/v1/knowledge/delete', respond: () => ({ status: 200, body: null }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.deleteRecord(7, ADMIN, /** @type {any} */ ({})), (e) => e.code === 'confirmation_required');
  assert.equal(f.calls.length, 0, 'no write before confirmation');

  const res = await m.knowledge.deleteRecord(7, ADMIN, { confirmPermanent: true });
  assert.equal(res.removed, 7);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(res._meta.scope, 'knowledge:7');
  assert.deepEqual(f.calls.find((c) => c.url.includes('/v1/knowledge/delete')).body, { id: 7 });
});

test('deleteRecord throws knowledge_in_use when an intellect still references the id in knowledge_ids', async () => {
  const f = fakeFetch([
    { match: '/v1/intellect/list', respond: () => ({ body: { objects: [{ id: 1481 }], totalCount: 1 } }) },
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 1481, knowledge_ids: [7] } }) },
    { match: '/v1/knowledge/delete', respond: () => ({ status: 200, body: null }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.knowledge.deleteRecord(7, ADMIN, { confirmPermanent: true }),
    (e) => e.code === 'knowledge_in_use' && /1481/.test(e.detail),
  );
  assert.equal(f.calls.some((c) => c.url.includes('/v1/knowledge/delete')), false, 'no delete call once a reference is found');
});

test('deleteRecord with {force:true} skips the in-use scan entirely and reports skippedInUseCheck', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/delete', respond: () => ({ status: 200, body: null }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.deleteRecord(7, ADMIN, { confirmPermanent: true, force: true });
  assert.equal(res.removed, 7);
  assert.equal(res.skippedInUseCheck, true);
  assert.equal(f.calls.some((c) => c.url.includes('/v1/intellect/list')), false, 'force must skip the scan');
});

test('updateRecord accepts a config patch and sends it verbatim on the wire', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const config = { sources: [{ type: 'internal', categoryIds: ['1'] }] };
  const res = await m.knowledge.updateRecord(7, { config }, ADMIN);
  assert.deepEqual(res.config, config);
  assert.deepEqual(f.calls[0].body, { id: 7, config });
});

test('updateRecord still rejects a patch with none of name/description/config', async () => {
  const f = fakeFetch([]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.knowledge.updateRecord(7, {}, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('addSource unions a new source with the existing config.sources and returns applied:true', async () => {
  const existing = { type: 'internal', categoryIds: ['1'] };
  const added = { type: 'internal', categoryIds: ['2'] };
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 7, config: { sources: [existing] } } }) },
    { match: '/v1/knowledge/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.addSource(7, added, ADMIN);
  assert.equal(res.applied, true);
  assert.deepEqual(f.calls.find((c) => c.url.includes('/v1/knowledge/update')).body.config.sources, [existing, added]);
});

test('addSource on a record with no prior config.sources produces [newSource] without crashing', async () => {
  const added = { type: 'internal', categoryIds: ['2'] };
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 7, config: {} } }) },
    { match: '/v1/knowledge/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.addSource(7, added, ADMIN);
  assert.equal(res.applied, true);
  assert.deepEqual(f.calls.find((c) => c.url.includes('/v1/knowledge/update')).body.config.sources, [added]);
});

test('addSource is idempotent: an exact-duplicate source is a no-op with no wire update call', async () => {
  const existing = { type: 'internal', categoryIds: ['1'] };
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 7, config: { sources: [existing] } } }) },
    { match: '/v1/knowledge/update', respond: () => { throw new Error('must not be called'); } },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.addSource(7, { type: 'internal', categoryIds: ['1'] }, ADMIN);
  assert.equal(res.applied, false);
  assert.equal(f.calls.some((c) => c.url.includes('/v1/knowledge/update')), false);
});

test('removeSource filters out a deep-equal match and returns applied:true', async () => {
  const keep = { type: 'internal', categoryIds: ['1'] };
  const drop = { type: 'internal', categoryIds: ['2'] };
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 7, config: { sources: [keep, drop] } } }) },
    { match: '/v1/knowledge/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.removeSource(7, { type: 'internal', categoryIds: ['2'] }, ADMIN);
  assert.equal(res.applied, true);
  assert.deepEqual(f.calls.find((c) => c.url.includes('/v1/knowledge/update')).body.config.sources, [keep]);
});

test('removeSource is idempotent: no matching source is a no-op with no wire update call', async () => {
  const keep = { type: 'internal', categoryIds: ['1'] };
  const f = fakeFetch([
    { match: '/v1/knowledge/get', respond: () => ({ body: { id: 7, config: { sources: [keep] } } }) },
    { match: '/v1/knowledge/update', respond: () => { throw new Error('must not be called'); } },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const res = await m.knowledge.removeSource(7, { type: 'internal', categoryIds: ['999'] }, ADMIN);
  assert.equal(res.applied, false);
  assert.equal(f.calls.some((c) => c.url.includes('/v1/knowledge/update')), false);
});

// ── listRecords ───────────────────────────────────────────────────────────────
// v1/knowledge/list — discover Knowledge RECORD containers, distinct from
// Knowledge#list (above), which lists KMS media ENTRIES in a category.

test('listRecords uses the Genie {pageIndex,pageSize} pager and returns the first page (async-iterable + awaitable)', async () => {
  const record = { id: 7, name: 'Product FAQ', status: 'READY', config: { sources: [] } };
  const f = fakeFetch([
    { match: '/v1/knowledge/list', respond: () => ({ body: { totalCount: 1, objects: [record] } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const page = await m.knowledge.listRecords(ADMIN);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, 7);
  const call = f.calls.find((c) => c.url.includes('/v1/knowledge/list'));
  assert.ok('pageIndex' in call.body.pager && 'pageSize' in call.body.pager, 'Genie pageIndex/pageSize pager, not offset/limit');
});

test('listRecords passes filter fields through verbatim (nameLike, statusIn, etc.)', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/list', respond: () => ({ body: { totalCount: 0, objects: [] } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.listRecords(ADMIN, { filter: { nameLike: 'faq', statusIn: ['READY'] } });
  const call = f.calls.find((c) => c.url.includes('/v1/knowledge/list'));
  assert.deepEqual(call.body.filter, { nameLike: 'faq', statusIn: ['READY'] });
});

test('listRecords defaults filter to {} when omitted', async () => {
  const f = fakeFetch([
    { match: '/v1/knowledge/list', respond: () => ({ body: { totalCount: 0, objects: [] } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  await m.knowledge.listRecords(ADMIN);
  const call = f.calls.find((c) => c.url.includes('/v1/knowledge/list'));
  assert.deepEqual(call.body.filter, {});
});

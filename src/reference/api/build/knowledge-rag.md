---
layout: base.njk
title: "Agent Components · Ground the Agent in Your Content (RAG)"
description: "Create a knowledge record, add sources, and check indexing status."
eyebrow: Reference
---

# Ground the Agent in Your Content (RAG)

[← Back to Agent Components](/reference/api/build/)


## Step 1: Create a knowledge record

```
POST https://genie.nvp1.ovp.kaltura.com/v1/knowledge/add
```

```json
{ "name": "Product Documentation" }
```

Returns `{ "id": 42, ... }`. Save the `id`.

**Don't already know the id?** `mgmt.knowledge.list(ks, opts)` discovers a partner's existing records. Pass `opts.filter.nameLike` to search by name. Use it to build a "pick an existing knowledge base" picker instead of hardcoding ids. A common flow is letting a user attach a knowledge base they created earlier to a brand-new agent.

This call is distinct from `knowledge.listCategoryEntries(categoryId, ks)`, which lists media *entries* inside one category, not Knowledge *record* containers.

```js
const page = await mgmt.knowledge.list(ks, { pageSize: 20, filter: { nameLike: 'Product' } });
page[0]; // { id: 42, name: 'Product Documentation', status: 'READY', config: { sources: [...] }, ... }
```

## Step 2: Link it to the intellect (at create or update)

```json
{
  "id": 1389,
  "knowledge_ids": [42],
  "capabilities": { "use_knowledge_base": "on" }
}
```

This is a normal intellect write. Retrieval works once indexing finishes.

> **`knowledge_ids` is capped at one record**, despite the plural array shape. `intellectConfig.setKnowledgeIds()` throws a typed `bad_request` before any network call if you pass more. To ground one agent in several content sources, upload them all into a single knowledge record.

## Step 3: Upload content into a category

`knowledge.uploadDocument()` (SDK) or the Kaltura OVP media ingest APIs put the actual media entries into a media category. `knowledge.createCategory()` creates that category if you don't already have one. A category is only a container. It is not connected to the knowledge record from Step 1 until Step 4.

## Step 4: Point the record at that category

A source names which content modalities to embed via `indexers[]`. Build that array with `buildIndexerObjects()` instead of hand-assembling it:

```js
import { buildIndexerObjects } from '@kaltura/intelligent-agents/management';

await mgmt.knowledge.addSource(
  id,
  { type: 'internal', categoryIds: [String(categoryId)], indexers: buildIndexerObjects(['document', 'caption']) },
  ks,
);
```

`knowledge.addSource(id, source, ks)` is the step that actually makes the uploaded content retrievable. A knowledge record with no `config.sources[]` entry has nothing to search, even with `knowledge_ids` linked and `use_knowledge_base: "on"`.

`knowledge.removeSource(id, source, ks)` is the inverse. Both calls change one entry of `config.sources[]` without disturbing the others, and are idempotent. Call them one at a time for the same record id, because two overlapping calls can lose one of the changes. To change sources, use these two calls. If you call `updateRecord({config}, ks)` directly, send the full `config`.

`buildIndexerObjects()` defaults to all three modalities (in this order: `document`, `caption`, `ocr`) when called with no arguments or an empty array:

| Modality | Source |
|----------|--------|
| `caption` | Video captions (SRT) |
| `ocr` | On-screen text |
| `document` | PDF / Markdown attachments |

## Full SDK sequence

`knowledge.addRecord()` → `knowledge.createCategory()` (or reuse an existing category) → `knowledge.uploadDocument()` → `knowledge.addSource()` → `intellectConfig.setKnowledgeIds()` → `knowledge.setEnabled(configId, true, ks)` (equivalent to the `capabilities.use_knowledge_base` write in Step 2). Skipping `addSource` leaves a linked, enabled knowledge base with nothing to search.

Re-pointing an existing intellect to a new or different knowledge record works the same way. Call `setKnowledgeIds()` again with the new id. It is a normal intellect update, with no separate linking call.

## Checking whether indexing has finished

`knowledge.isIndexed(id, ks)` reads `knowledge.getRecord(id, ks).status`. That status reads `"READY"` as soon as the record exists, before any entry is indexed. Do not treat `isIndexed()` returning `ready:true` as proof your content is searchable.

Don't use `knowledge.search()` as a substitute either. Its "couldn't find relevant information" reply is the same for an unindexed knowledge base, an indexed knowledge base with `use_knowledge_base:'off'`, and a query with no match, so it does not show indexing status. `knowledge.corpusStatus()` only counts entries in the category, not whether they finished indexing.

`knowledge.entryStatus(knowledgeId, entryIds, ks)` is the per-entry indexing-status check. Use it to verify that specific uploaded content has finished indexing. Poll it instead of using a fixed wait:

```js
async function pollUntilIndexed(mgmt, knowledgeId, entryIds, ks, { intervalMs = 5000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(entryIds);
  while (pending.size && Date.now() < deadline) {
    const { entries } = await mgmt.knowledge.entryStatus(knowledgeId, [...pending], ks);
    // entries omits an id until it has finished indexing, then reports its documents' status.
    for (const entry of entries) {
      if (entry.documents?.every((d) => d.status)) pending.delete(entry.entry_id);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return pending.size === 0; // false means the timeout ran out before every entry confirmed
}
```

Resolve that poll **before** you create or update the intellect. Send `use_knowledge_base:'on'` in that same `intellectConfig` call alongside `knowledge_ids`, not as a follow-up capability patch. Why: [Client-Side Commands § Gotcha 2](/guides/client-commands/#gotcha-2-set-capabilities-at-creation-not-after).

---

## Related docs

| Doc | What it adds |
|---|---|
| [Agent Components · Create and Configure an Intellect](/reference/api/build/intellect/) | The `knowledge_ids`/`use_knowledge_base` fields this section links into |
| [Agent Components](/reference/api/build/) | The Agent Components index |


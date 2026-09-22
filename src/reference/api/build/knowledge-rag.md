---
layout: base.njk
title: "Agent Components · Ground the Agent in Your Content (RAG)"
description: "Create a knowledge record, add sources, and check indexing status."
eyebrow: Reference
---

# Ground the Agent in Your Content (RAG)

[← Back to Agent Components](/reference/api/build/)


## Step 1 — Create a knowledge record

```
POST https://genie.nvp1.ovp.kaltura.com/v1/knowledge/add
```

```json
{ "name": "Product Documentation" }
```

Returns `{ "id": 42, ... }`. Save the `id`.

**Don't already know the id?** `mgmt.knowledge.list(ks, opts)` discovers a partner's existing records — pass `opts.filter.nameLike` to search by name. Use it to build a "pick an existing knowledge base" picker instead of hardcoding ids. A common flow is letting a user attach a knowledge base they created earlier to a brand-new agent.

This call is distinct from `knowledge.listCategoryEntries(categoryId, ks)`, which lists media *entries* inside one category, not Knowledge *record* containers.

```js
const page = await mgmt.knowledge.list(ks, { pageSize: 20, filter: { nameLike: 'Product' } });
page[0]; // { id: 42, name: 'Product Documentation', status: 'READY', config: { sources: [...] }, ... }
```

## Step 2 — Link it to the intellect (at create or update)

```json
{
  "id": 1389,
  "knowledge_ids": [42],
  "capabilities": { "use_knowledge_base": "on" }
}
```

Writes through the intellect object: no `partner-config/update`, no 403. RAG retrieval works after async indexing.

> **`knowledge_ids` is capped at one record**, despite the plural array shape — the server rejects more. The SDK's `intellectConfig.setKnowledgeIds()` enforces this client-side with a typed `bad_request` before any network call. To ground one agent in several content sources, upload them all into a single knowledge record.

## Step 3 — Upload content into a category

`knowledge.uploadDocument()` (SDK) or the Kaltura OVP media ingest APIs put the actual media entries into a media category. `knowledge.createCategory()` creates that category if you don't already have one. A category is just a container; on its own it's not connected to the knowledge record from Step 1.

## Step 4 — Point the record at that category

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

`knowledge.removeSource(id, source, ks)` is the inverse. Both calls read-merge-write one entry of `config.sources[]` without disturbing the others, and are idempotent, but not safe to call concurrently for the same record id: two overlapping calls read the same pre-write `config.sources`, so the second write silently drops the first's change. Don't hand-assemble `config.sources` via `updateRecord({config}, ks)` directly unless you intend a full replace: the backend overwrites the entire `config` on that field.

`buildIndexerObjects()` defaults to all three modalities (in this order: `document`, `caption`, `ocr`) when called with no arguments or an empty array:

| Modality | Source |
|----------|--------|
| `caption` | Video captions (SRT) |
| `ocr` | On-screen text |
| `document` | PDF / Markdown attachments |

## Full SDK sequence

`knowledge.addRecord()` → `knowledge.createCategory()` (or reuse an existing category) → `knowledge.uploadDocument()` → `knowledge.addSource()` → `intellectConfig.setKnowledgeIds()` → `knowledge.setEnabled(configId, true, ks)` (equivalent to the `capabilities.use_knowledge_base` write in Step 2). Skipping `addSource` is the most common way to end up with a linked, enabled, but silently empty knowledge base.

Re-pointing an existing intellect to a new or different knowledge record works the same way — call `setKnowledgeIds()` again with the new id. It's a normal `v1/intellect/update` write, no separate linking call, no gate.

## Checking whether indexing has finished

`knowledge.isIndexed(id, ks)` reads `knowledge.getRecord(id, ks).status`. But `status` is the knowledge record's own container-lifecycle flag (`"READY"`/`"DELETED"`), not an indexing-completion signal. It reads `"READY"` immediately once the record exists, before any entry has been indexed. That happens because a knowledge base is open-ended — you can always add more entries — so there's no single "fully indexed" state for the record as a whole. Don't treat `isIndexed()` returning `ready:true` as proof your content is searchable yet.

Don't use `knowledge.search()` as a substitute either. Its "couldn't find relevant information" reply fires alike for an unindexed knowledge base, an indexed knowledge base with `use_knowledge_base:'off'`, or a genuine no-match query, so it can't signal indexing status. `knowledge.corpusStatus()` only counts entries that exist in the category, not whether they've finished embedding.

`knowledge.entryStatus(knowledgeId, entryIds, ks)` is the official per-entry indexing-status check, and the correct way to verify specific uploaded content has finished indexing. Poll it instead of guessing with a fixed wait:

```js
async function pollUntilIndexed(mgmt, knowledgeId, entryIds, ks, { intervalMs = 5000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(entryIds);
  while (pending.size && Date.now() < deadline) {
    const { entries } = await mgmt.knowledge.entryStatus(knowledgeId, [...pending], ks);
    // entries omits an id until it's finished indexing, then reports its documents' status.
    for (const entry of entries) {
      if (entry.documents?.every((d) => d.status)) pending.delete(entry.entry_id);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return pending.size === 0; // false means the timeout ran out before every entry confirmed
}
```

Resolve that poll **before** you create or update the intellect, and send `use_knowledge_base:'on'` in that same `intellectConfig` call alongside `knowledge_ids`, not as a follow-up capability patch. Partner config is cached for up to 24h server-side (see [Client-Side Commands's Gotcha 2](/guides/client-commands/#gotcha-2--partner-config-is-cached-24h-set-capabilities-at-creation-not-after)). A two-step create-then-flip risks the cache latching onto the transient `off` value from step one and never seeing step two's `on`. A single write after the poll avoids that race entirely for a fresh create.

---

## Related docs

| Doc | What it adds |
|---|---|
| [Agent Components · Create and Configure an Intellect](/reference/api/build/intellect/) | The `knowledge_ids`/`use_knowledge_base` fields this section links into |
| [Agent Components](/reference/api/build/) | The Agent Components index |


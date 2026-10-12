---
layout: base.njk
title: "Case Study: Nova"
description: "Nova is the live Kaltura Agentic Avatar embedded on this site, built on this SDK, with fully public source. Here's what she's a working example of."
eyebrow: Explanation
---

# Case Study: Nova

> **TL;DR:** Nova, the avatar on this site, runs on `@kaltura/intelligent-agents` and is fully open source. Her repo is the reference implementation for two things customers ask about most: knowing when a knowledge base has finished indexing, and running evals against a live agent.

Nova isn't a demo built to look good in a screenshot. She's the same avatar you can talk to right now, on this site, running the same code you can read at [github.com/kaltura/docs-site-avatar](https://github.com/kaltura/docs-site-avatar). That repo provisions her, redeploys her, and proves she behaves correctly before every release. It's public, so you can study the patterns or lift them directly into your own build.

## Checking whether your knowledge base finished indexing

When you ground an Agentic Avatar in your own content, there is a gap between uploading it and the avatar being able to cite it. Indexing runs asynchronously and can take several minutes on a cold knowledge base.

`knowledge.isIndexed()` is not the signal to wait on. It reports ready the moment the knowledge record exists, before any of the entries you just uploaded have indexed. The real per-entry check is `knowledge.entryStatus()`.

Nova's own provisioning script polls it, up to a bounded budget, before it creates or updates her intellect (the agent's AI configuration). This is the same pattern documented in [Ground the Agent in Your Content (RAG)](/reference/api/build/knowledge-rag/#ground-the-agent-in-your-content-rag).

Nova also sets `use_knowledge_base` to `on` in the same create or update call that attaches the knowledge record, not in a follow-up patch. One write keeps the configuration consistent. See [`server/provision.mjs`](https://github.com/kaltura/docs-site-avatar/blob/main/server/provision.mjs) for the live version of this sequencing.

## Running evals against your agent

Once an agent is live, "does it still behave correctly" is an ongoing question, not a one-time check. Nova's eval suite runs her through adversarial personas. It scores each turn against release-blocking and soft dimensions. It also repeats each persona across multiple independent trials, to catch reliability gaps a single pass would miss. This is pass^k, not pass@k: a customer-facing agent needs to hold up across many conversations, not just one lucky one.

The suite is documented in [`docs/EVALS.md`](https://github.com/kaltura/docs-site-avatar/blob/main/docs/EVALS.md). Its design rationale is covered in [`docs/ARCHITECTURE.md`](https://github.com/kaltura/docs-site-avatar/blob/main/docs/ARCHITECTURE.md#about-the-eval-harness-as-a-reusable-pattern): why adversarial personas, why pass^k, and why some failures block a release and others don't. Both were written to be lifted, not just read: you can point the harness at your own agent's personas and probes.

## Where to go next

- [Ground the Agent in Your Content (RAG)](/reference/api/build/knowledge-rag/#ground-the-agent-in-your-content-rag): the indexing recipe in full
- [docs-site-avatar on GitHub](https://github.com/kaltura/docs-site-avatar): Nova's complete source, provisioning script, and eval suite
- [Getting Started](/getting-started/): build your first agent with this SDK

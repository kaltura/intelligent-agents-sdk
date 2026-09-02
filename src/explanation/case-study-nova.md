---
layout: base.njk
title: "Case Study: Nova"
description: "Nova is the live Kaltura Agentic Avatar embedded on this site, built on this SDK, with fully public source. Here's what she's a working example of."
eyebrow: Explanation
---

# Case Study: Nova

> **TL;DR** — Nova, the avatar on this site, runs on `@kaltura/intelligent-agents`
> and is fully open source. Her repo is the reference implementation for two
> things customers ask about most: knowing when a knowledge base has finished
> indexing, and running evals against a live agent.

Nova isn't a demo built to look good in a screenshot. She's the same avatar
you can talk to right now, on this site, running the same code you can read
at [github.com/kaltura/docs-site-avatar](https://github.com/kaltura/docs-site-avatar).
That repo provisions her, redeploys her, and proves she behaves correctly
before every release — and it's public so you can study the patterns or lift
them directly into your own build.

## Checking whether your knowledge base finished indexing

Ground a Kaltura Agentic Avatar in your own content and there's a gap between
uploading it and the avatar being able to cite it: indexing runs
asynchronously and can take 45-90 seconds or more on a cold knowledge base.
There's no reliable signal yet that tells you indexing has actually finished —
`knowledge.isIndexed()` reads the knowledge record's own container status,
which reports ready the instant the record exists, before any of the entries
you just uploaded have indexed. A real per-entry check
(`knowledge.entryStatus()`) exists but is not yet generally available on every
deployment — check with your Kaltura account team before building on it. Until
then, Nova's own provisioning script budgets a fixed best-effort wait before
it ever creates or updates her intellect — the same pattern documented in
[Ground the Agent in Your Content (RAG)](/reference/api/build/#ground-the-agent-in-your-content-rag).

Nova resolves that wait *before* the create/update call, not after, because
partner configuration is cached for up to 24 hours server-side. A capability
flip sent as a follow-up patch can miss that cache window entirely. See
[`server/provision.mjs`](https://github.com/kaltura/docs-site-avatar/blob/main/server/provision.mjs)
for the live version of this sequencing.

## Running evals against your agent

Once an agent is live, "does it still behave correctly" is an ongoing
question, not a one-time check. Nova's eval suite runs her through adversarial
personas, scores each turn against release-blocking and soft dimensions, and
repeats each persona across multiple independent trials to catch
reliability gaps a single pass would miss — pass^k, not pass@k, since a
customer-facing agent needs to hold up across many conversations, not just
one lucky one.

The suite is documented in [`docs/EVALS.md`](https://github.com/kaltura/docs-site-avatar/blob/main/docs/EVALS.md)
and its design rationale — why adversarial personas, why pass^k, why some
failures block a release and others don't — is covered in [`docs/ARCHITECTURE.md`](https://github.com/kaltura/docs-site-avatar/blob/main/docs/ARCHITECTURE.md#about-the-eval-harness-as-a-reusable-pattern).
Both were written to be lifted, not just read: the harness has no dependency
on Nova specifically, so you can point it at your own agent's personas and
probes.

## Where to go next

- [Ground the Agent in Your Content (RAG)](/reference/api/build/#ground-the-agent-in-your-content-rag) — the indexing recipe in full
- [docs-site-avatar on GitHub](https://github.com/kaltura/docs-site-avatar) — Nova's complete source, provisioning script, and eval suite
- [Getting Started](/getting-started/) — build your first agent with this SDK

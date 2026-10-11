---
layout: base.njk
title: "Architecture Reference"
description: "The connect sequence, recovery behavior, scaling and sticky sessions, and failure-mode tables behind the SDK's architecture."
eyebrow: Reference
---

# Architecture Reference

Exact timings, steps and failure handling behind [Platform Overview](/explanation/architecture/). Read ARCHITECTURE.md first for the big picture. For a from-scratch client, see [ARCHITECTURE-RECIPE.md](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/ARCHITECTURE-RECIPE.md). For every socket event, see [Wire Protocol](/reference/wire-protocol/).

| Doc | Covers |
|---|---|
| [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | Endpoints and credentials, the full connect sequence, connect timeouts and errors, `prepare()`, connect timings |
| [Architecture Reference · Scale and Sticky Sessions](/reference/architecture-reference/scale-and-sticky-sessions/) | Sticky routing, the capacity queue and `waitForCapacity` |
| [Architecture Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | Recovery layers, ICE diagnostics, device permissions, the failure-mode matrix, the tool-call spiral breaker, page exit |


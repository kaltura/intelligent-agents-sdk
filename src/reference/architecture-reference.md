---
layout: base.njk
title: "System Internals Reference"
description: "The exact field-by-field mechanics behind the SDK's architecture: the connect sequence, wire shapes, scaling internals, SDK module routing, and failure-mode tables."
eyebrow: Reference
---

# System Internals Reference

The exact field-by-field mechanics behind [Platform Overview](/explanation/architecture/) — the connect sequence, wire shapes, scaling internals, SDK module routing, and failure-mode tables. Read ARCHITECTURE.md first for the big picture; consult these docs for an exact field, timeout, or module boundary. For a from-scratch reimplementation walkthrough, see [Minimal Reimplementation Recipe](/reference/architecture-recipe/). For the exhaustive socket-event-by-event capture, see [Wire Protocol](/reference/wire-protocol/).

| Doc | Covers |
|---|---|
| [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | Endpoints & Credentials, Socket.IO Connection, Full Connect Sequence, the `join` payload |
| [System Internals Reference · Audio & Video Wiring](/reference/architecture-reference/channels/) | ASR Channel — Microphone Uplink, STV Channel — Avatar Video Downlink |
| [System Internals Reference · Conversation Flow](/reference/architecture-reference/conversation-flow/) | Conversation Phase (brain output, talking state, lifecycle events), Sending User Input, Complete Message Catalog |
| [System Internals Reference · Scale and Sticky Sessions](/reference/architecture-reference/scale-and-sticky-sessions/) | Sticky routing, the capacity queue, connection vs. session recovery, externalized session state |
| [System Internals Reference · Module Map and Data Flow](/reference/architecture-reference/module-map-and-data-flow/) | SDK module map, `resolveCapabilities` shape, the GenUI layer, DTO routing rules, honest limits |
| [System Internals Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | Reconnection tiers, device permissions, the failure-mode matrix, the tool-call-spiral breaker, session-completion signal |


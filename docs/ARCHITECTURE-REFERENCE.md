# Architecture Reference

The exact field-by-field mechanics behind [ARCHITECTURE.md](ARCHITECTURE.md) — the connect sequence, wire shapes, scaling internals, SDK module routing, and failure-mode tables. Read ARCHITECTURE.md first for the big picture; consult these docs for an exact field, timeout, or module boundary. For a from-scratch reimplementation walkthrough, see [ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md). For the exhaustive socket-event-by-event capture, see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

| Doc | Covers |
|---|---|
| [architecture-reference/connection-and-handshake.md](architecture-reference/connection-and-handshake.md) | Endpoints & Credentials, Socket.IO Connection, Full Connect Sequence, the `join` payload |
| [architecture-reference/channels.md](architecture-reference/channels.md) | ASR Channel — Microphone Uplink, STV Channel — Avatar Video Downlink |
| [architecture-reference/conversation-flow.md](architecture-reference/conversation-flow.md) | Conversation Phase (brain output, talking state, lifecycle events), Sending User Input, Complete Message Catalog |
| [architecture-reference/scale-and-sticky-sessions.md](architecture-reference/scale-and-sticky-sessions.md) | Sticky routing, the capacity queue, connection vs. session recovery, externalized session state |
| [architecture-reference/module-map-and-data-flow.md](architecture-reference/module-map-and-data-flow.md) | SDK module map, `resolveCapabilities` shape, the GenUI layer, DTO routing rules, honest limits |
| [architecture-reference/resilience-and-failure-handling.md](architecture-reference/resilience-and-failure-handling.md) | Reconnection tiers, device permissions, the failure-mode matrix, the tool-call-spiral breaker, session-completion signal |

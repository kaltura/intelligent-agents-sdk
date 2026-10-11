# Architecture Reference

Exact timings, steps and failure handling behind [ARCHITECTURE.md](ARCHITECTURE.md). Read ARCHITECTURE.md first for the big picture. For a from-scratch client, see [ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md). For every socket event, see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

| Doc | Covers |
|---|---|
| [architecture-reference/connection-and-handshake.md](architecture-reference/connection-and-handshake.md) | Endpoints and credentials, the full connect sequence, connect timeouts and errors, `prepare()`, connect timings |
| [architecture-reference/scale-and-sticky-sessions.md](architecture-reference/scale-and-sticky-sessions.md) | Sticky routing, the capacity queue and `waitForCapacity` |
| [architecture-reference/resilience-and-failure-handling.md](architecture-reference/resilience-and-failure-handling.md) | Recovery layers, ICE diagnostics, device permissions, the failure-mode matrix, the tool-call spiral breaker, page exit |

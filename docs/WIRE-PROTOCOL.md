# Wire Protocol — Socket.IO + WebRTC Reference

The complete, verified map of **every event, payload, config, and flow** on the two channels that power the interactive live avatar: the **Socket.IO control plane** and the **two WebRTC peer connections** (ASR mic-uplink + STV video-downlink).

This is the deep reference behind [ARCHITECTURE.md](ARCHITECTURE.md) → "Video Runtime Protocol". Read ARCHITECTURE.md first for the big picture; read the pages below when you need the exact field of an exact event, the exact ICE config, or the exact order things fire.

| Doc | Covers |
|---|---|
| [wire-protocol/connection-basics.md](wire-protocol/connection-basics.md) | Provenance/components, channels at a glance, the Socket.IO connection, the connect sequence (state-machine order) |
| [wire-protocol/events-catalog.md](wire-protocol/events-catalog.md) | The full Socket.IO events catalog: client→server emits, server→client events, the `agent_raw_text.delta` brain stream, `speechId`/barge-in |
| [wire-protocol/audio-channels.md](wire-protocol/audio-channels.md) | The ASR uplink (pc1) and STV downlink (pc2) WebRTC peer connections, ICE config, WHEP signaling |
| [wire-protocol/client-configuration.md](wire-protocol/client-configuration.md) | `clientConfiguration` fields and structured experiences (`force_experience` + `unisphere-tool`) |
| [wire-protocol/end-to-end-turn.md](wire-protocol/end-to-end-turn.md) | A full turn trace, event by event, plus how to reproduce/re-capture your own |

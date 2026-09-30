# Wire Protocol — Socket.IO + WebRTC Reference

This is the complete, verified map of **every event, payload, config, and flow** on the two channels that power the interactive live avatar. Those two channels are the **Socket.IO control plane** and the **two WebRTC peer connections** (ASR mic-uplink + STV video-downlink).

This is the deep reference behind [ARCHITECTURE.md](ARCHITECTURE.md) → "Video Runtime Protocol". Read ARCHITECTURE.md first for the big picture. Come back to the pages below when you need an exact event field, the exact ICE config, or the exact order events fire.

| Doc | Covers |
|---|---|
| [wire-protocol/connection-basics.md](wire-protocol/connection-basics.md) | Channels at a glance, the Socket.IO connection, and a pointer to the connect sequence |
| [wire-protocol/events-catalog.md](wire-protocol/events-catalog.md) | The full Socket.IO events catalog: client→server emits, server→client events, the `agent_raw_text.delta` brain stream, and `speechId` grouping |
| [wire-protocol/audio-channels.md](wire-protocol/audio-channels.md) | The ASR uplink (pc1) and STV downlink (pc2) WebRTC peer connections, TURN and ICE options, WHEP signaling |
| [wire-protocol/client-configuration.md](wire-protocol/client-configuration.md) | `clientConfiguration` fields and structured experiences (`force_experience` + `unisphere-tool`) |
| [wire-protocol/end-to-end-turn.md](wire-protocol/end-to-end-turn.md) | A full turn trace, event by event, plus how to reproduce/re-capture your own |

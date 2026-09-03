---
layout: base.njk
title: "Wire Protocol"
description: "The complete, verified map of every event, payload, config, and flow on the Socket.IO control plane and the two WebRTC peer connections (ASR mic-uplink and STV video-downlink) that power the interactive live avatar."
eyebrow: Reference
---

# Wire Protocol — Socket.IO + WebRTC Reference

The complete, verified map of **every event, payload, config, and flow** on the two channels that power the interactive live avatar: the **Socket.IO control plane** and the **two WebRTC peer connections** (ASR mic-uplink + STV video-downlink).

This is the deep reference behind [Platform Architecture](/explanation/architecture/) → "Video Runtime Protocol". Read ARCHITECTURE.md first for the big picture; read the pages below when you need the exact field of an exact event, the exact ICE config, or the exact order things fire.

| Doc | Covers |
|---|---|
| [Wire Protocol · Connection Basics](/reference/wire-protocol/connection-basics/) | Provenance/components, channels at a glance, the Socket.IO connection, the connect sequence (state-machine order) |
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | The full Socket.IO events catalog: client→server emits, server→client events, the `agent_raw_text.delta` brain stream, `speechId`/barge-in |
| [Wire Protocol · Audio Channels](/reference/wire-protocol/audio-channels/) | The ASR uplink (pc1) and STV downlink (pc2) WebRTC peer connections, ICE config, WHEP signaling |
| [Wire Protocol · Client Configuration](/reference/wire-protocol/client-configuration/) | `clientConfiguration` fields and structured experiences (`force_experience` + `unisphere-tool`) |
| [Wire Protocol · End-to-End Turn](/reference/wire-protocol/end-to-end-turn/) | A full turn trace, event by event, plus how to reproduce/re-capture your own |


---
layout: base.njk
title: "Inside a Live Conversation"
description: "Every live Agentic Avatar conversation runs three flows at once. Kaltura runs two of them. Your AI stack is the third — here's where it plugs in."
eyebrow: Explanation
---

# Inside a Live Conversation

> **TL;DR** — Your AI stack is one of three flows in a live conversation.
> Kaltura runs the other two. Plug yours in — here's the call.

```js
import { Management, tools } from '@kaltura/intelligent-agents/management';

const kaltura = new Management({
  partnerId: process.env.AGENTIC_PARTNER_ID,
  adminSecret: process.env.AGENTIC_ADMIN_SECRET,
});
const { ks: adminKs } = await kaltura.sessions.createAdminToken();
const configId = 'YOUR_CONFIG_ID'; // from Getting Started — create-agent.mjs prints it

// Plug one of your APIs into the orchestration flow (swap in your own endpoint):
const { id: toolId } = await kaltura.tools.add(tools.api({
  name: 'get_exchange_rate',
  description: 'Fetch the latest exchange rates when the visitor asks about currency.',
  args: { base: { type: 'str', prompt: 'Three-letter base currency code, e.g. USD', required: true } },
  request: { url: 'https://api.frankfurter.dev/v1/latest', method: 'GET', params: { base: '{{args.base}}' } },
  responseMapping: { base: 'base', date: 'date', rates: 'rates' },
}), adminKs);
await kaltura.intellectConfig.setToolIds(configId, [toolId], adminKs);

// Ask — the agent calls your API mid-conversation:
const reply = await kaltura.converseOnce(configId, 'How many euros is one US dollar right now?');
console.log(reply.text);
```

When someone talks with an Agentic Avatar, three flows run at once. You see
one avatar. Underneath, two engineered systems keep the conversation coherent
in real time, and your expertise feeds the answers.

## The three flows

<div data-nova-target="three-flows-table" data-nova-label="The three flows in every live conversation">

| Flow | Name | What it covers | Who runs it |
|---|---|---|---|
| 1 | **Conversation Control** | Turn-taking and interruptions, real-time sync of speech recognition, voice, avatar video, and language models, expression and emotion control, session recording, device and cross-platform coverage, screen share. [Read more →](/explanation/architecture/) | Kaltura, always |
| 2 | **Agent Orchestration** | The server-side reasoning loop that runs while the person talks: grounding answers in knowledge (RAG), calling tools, routing to expert agents. [Read more →](/reference/api/build/knowledge-rag/#ground-the-agent-in-your-content-rag) | Kaltura, always |
| 3 | **Your Expertise** | Your knowledge bases, your APIs and data, your own models and expert agents, your IP. [Read more →](/guides/external-api-integrations/) | You, plugged into flow 2 |

</div>

## Bring your own expertise

Your existing AI stack isn't a replacement for flows 1 and 2. It's flow 3.
The SDK ships the plug points today:

- **Knowledge base grounding** — index your content and the agent cites it
  live (`use_knowledge_base`). See [Ground the Agent](/reference/api/build/knowledge-rag/#ground-the-agent-in-your-content-rag).
- **External API and tool integrations** — the agent calls your endpoints
  mid-conversation, with server-held secrets. See
  [External API Integrations](/guides/external-api-integrations/).
- **Per-message variables** (`request_vars`) — inject your own context, per
  turn, from your backend. See the [API Reference](/reference/api-reference/).
- **Client-side commands** — the agent drives your page UI through functions
  you define. See [Client-Side Commands](/guides/client-commands/).

## What you'd take on yourself

Scripted avatar sessions (puppet mode: you supply every line of speech) skip
flows 1 and 2. Use only those, and this list becomes yours to build and
operate:

<div data-nova-target="build-yourself-checklist" data-nova-label="What you'd build yourself without the agentic runtime">

- Turn-taking and barge-in (the visitor interrupts, the avatar yields)
- Live sync across speech recognition → language model → voice → avatar video
- Latency budgets across that whole chain
- Expression and emotion control
- Reconnection and session recovery
- Session recording
- Device and browser coverage
- Knowledge grounding and tool orchestration
- Conversation analytics

</div>

## Analytics come with the runtime

Full agentic sessions feed engagement analytics out of the box
(`./experience/analytics` — see [KAVA analytics](/reference/sdk-reference/#kava-analytics-opt-in-client-only-application-events)).
A self-built pipeline has to recreate that measurement loop too.

## Where scripted sessions do fit

Pre-authored narration, puppet-style playback, and demo reels are real use
cases — you author every word, and the avatar performs it. That's what
[scripted avatar sessions](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/api/scripted-video.md)
are for. For anything a visitor talks back to, you want all three flows.

## Next steps

- [Getting Started](/getting-started/) — a working agent in about five minutes
- [External API Integrations](/guides/external-api-integrations/) — the full plug-in guide
- [Platform Architecture](/explanation/architecture/) — how the pieces fit together

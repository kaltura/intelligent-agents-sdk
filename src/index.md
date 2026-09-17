---
layout: base.njk
title: "Home"
description: "A zero-dependency JavaScript SDK for building and operating Kaltura Agentic Avatars — conversational agents with a visual, human-like avatar interface."
eyebrow: Agentic Avatars SDK
bodyClass: home
---

# @kaltura/intelligent-agents

A zero-dependency JavaScript SDK for building and operating **Kaltura Agentic
Avatars**: Kaltura's conversational agents with a visual, human-like avatar
interface.

<section class="nova-hero" aria-labelledby="nova-hero-heading">
  <div class="nova-hero-inner">
    <div class="nova-hero-copy">
      <h2 id="nova-hero-heading">Meet Nova</h2>
      <p>Nova is a live Kaltura Agentic Avatar, provisioned with this SDK's own
      Management API and grounded on this site's own documentation. She knows
      every page here. Ask her what the SDK does, whether it fits your use
      case, or which page to read next. She'll take you there herself.</p>
      <div class="nova-hero-prompts" role="group" aria-label="Suggested questions for Nova">
        <span class="nova-hero-prompts-label">Try asking:</span>
        <button type="button" class="nova-chip" data-prompt="What can you help me do on this site?">What can you do?</button>
        <button type="button" class="nova-chip" data-prompt="Show me a quick code example to get started.">Show me a code example</button>
        <button type="button" class="nova-chip" data-prompt="Is this SDK free to use, and do I need a Kaltura account?">Is it free to use?</button>
        <button type="button" class="nova-chip" data-prompt="Take me to the Getting Started guide.">Take me to Getting Started</button>
        <button type="button" class="nova-chip" data-prompt="We already have our own AI. What does Kaltura's runtime add?">I have my own AI — why Kaltura?</button>
      </div>
    </div>
    <div class="nova-hero-visual" id="nova-hero-slot"></div>
  </div>
</section>

Two entry points, plus optional plugin subpaths that don't bloat the base
runtime:

- **`./management`**: provision, configure, and measure agents (server-side)
- **`./experience`**: the live interactive runtime, a socket connection plus WHEP video streaming (browser)
- **`./experience/presenter`**: the `Presenter` deck-walkthrough plugin
- **`./experience/genui`**: renders GenUI widgets, on-screen UI elements the agent can generate, using `ExperienceRenderer`/`mountWidget`
- **`./experience/analytics`**: `KavaAnalytics`, client-only analytics events (KAVA)
- **`./experience/noise-suppressor`**: a zero-dependency AudioWorklet noise gate
- **`./experience/chroma-key`**: transparent-background avatar compositor (bring your own `chroma-key-video`)

## One avatar, three flows

When someone talks with an Agentic Avatar, three flows run at once:

- **Conversation Control**: turn-taking, interruptions, and real-time sync of speech, video, and language models
- **Agent Orchestration**: knowledge grounding, tool calls, and expert-agent routing
- **Your Expertise**: your knowledge bases, APIs, and models

Kaltura runs the first two the moment you connect. Yours plugs into the third. [See how the flows fit together](/explanation/inside-a-live-conversation/).

## Why this SDK

- **Readable source, no build step.** Raw ESM you can read line by line.
  Import it straight from a [jsDelivr CDN URL](#quick-start-in-the-browser)
  pinned to a git tag. No install step, no bundler-only `node_modules`
  black box.
- **Zero runtime dependencies.** No extra dependencies to audit for
  supply-chain risk.
- **Self-serve cloning.** Voice and visual cloning are SDK calls, not a
  support ticket.
- **Security designed in.** Pre-redacted audit events, short-lived tokens,
  and a NIST 800-53 control matrix. Built for enterprise, HIPAA, and
  HITRUST deployments from the start.

## Quick start in the browser

Once a tag is pinned, jsDelivr serves the SDK straight from GitHub. No
`npm install`, no bundler:

<div data-nova-target="jsdelivr-quickstart" data-nova-label="Quick-start browser code example">

<!-- SDK version pin -- keep in sync with: intelligent-agents-sdk-site/src/assets/nova/sdk.js
     (SDK_TAG constant) and docs-site-avatar/scripts/fetch-sdk.mjs (DEFAULT_TAG). -->
```html
<script type="module">
  import { KalturaAvatarSession } from 'https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.22.0/src/experience/index.js';

  const session = new KalturaAvatarSession({
    token,               // conversation KS, from your backend
    conversationManagerUrl, srsBaseUrl, turnServerUrl,  // from your backend's appInit response
    videoEl: document.querySelector('video'),
  });

  await session.connect();
</script>
```

</div>

Pin the tag for anything you ship. jsDelivr caches a tagged path forever, so
a pin is both stable and fast. See [Getting Started](/getting-started/) for
where `token` and the other connection values come from.

## Where to go next

<div data-nova-target="where-to-go-next" data-nova-label="Where to go next">

**New to the SDK?** Start with [Getting Started](/getting-started/). Go from
zero to a talking AI avatar in about five minutes, once you have a Kaltura
account.

**Building a real app?** The How-to Guides cover the specific problems apps
run into:

- Driving your UI from the avatar
- Injecting per-request data
- Choosing a voice-input mode
- Collecting structured form data
- Reimplementing the runtime from scratch

**Need to look something up?** The Reference section covers every endpoint,
socket event, GenUI widget, and architecture detail:

- API Reference
- Wire Protocol
- GenUI Reference
- The full use-case catalog

**Want the bigger picture?** Platform Overview, under Explanation, covers
the two backends, the live-video runtime, and how the pieces fit together.
Read it when you want to understand *why*, not just *how*.

</div>

## Security and compliance

Zero runtime dependencies, short-lived tokens, pre-redacted audit events, and
a NIST 800-53 control matrix. Built for enterprise, HIPAA, and HITRUST
deployments. See [`SECURITY.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/SECURITY.md) in the repository for the full control
matrix.

## License

MIT. You don't need a Kaltura account or credentials to read, fork, or build
on this SDK's source. To call the live APIs it wraps, you need a Kaltura
account with the Agentic Avatar feature enabled.

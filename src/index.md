---
layout: base.njk
title: "Home"
description: "A zero-dependency JavaScript SDK for building and operating Kaltura Agentic Avatars — conversational agents with a visual, human-like avatar interface."
eyebrow: Agentic Avatars SDK
bodyClass: home
---

# @kaltura/intelligent-agents

A zero-dependency JavaScript SDK for building and operating **Kaltura Agentic
Avatars** — Kaltura's conversational agents with a visual, human-like avatar
interface.

<section class="nova-hero" aria-labelledby="nova-hero-heading">
  <div class="nova-hero-inner">
    <div class="nova-hero-copy">
      <h2 id="nova-hero-heading">Meet Nova</h2>
      <p>Nova is a live Kaltura Agentic Avatar, provisioned with this SDK's own
      Management API and grounded on this site's own documentation. She knows
      every page here — ask her what the SDK does, whether it fits your use
      case, or which page to read next, and she'll take you there herself.</p>
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

- **`./management`** — provision, configure, and measure agents (server-side)
- **`./experience`** — the live interactive runtime: socket + WHEP video (browser)
- **`./experience/presenter`** — the `Presenter` deck-walkthrough plugin
- **`./experience/genui`** — `ExperienceRenderer`/`mountWidget` GenUI widget rendering
- **`./experience/analytics`** — `KavaAnalytics`, client-only KAVA Application Events
- **`./experience/noise-suppressor`** — a zero-dependency AudioWorklet noise gate
- **`./experience/chroma-key`** — transparent-background avatar compositor (bring your own `chroma-key-video`)

## One avatar, three flows

When someone talks with an Agentic Avatar, three flows run at once: **Conversation Control** (turn-taking, interruptions, real-time sync of speech, video, and language models), **Agent Orchestration** (knowledge grounding, tool calls, expert-agent routing), and **Your Expertise** (your knowledge bases, APIs, and models). The first two run for you the moment you connect. Yours plugs in — [see how the flows fit together](/explanation/inside-a-live-conversation/).

## Why this SDK

- **Readable source, no build step** — raw ESM you can read line by line;
  import straight from a [jsDelivr CDN URL](#quick-start-in-the-browser)
  pinned to a git tag. No install step, no bundler-only `node_modules`
  black box.
- **Zero runtime dependencies** — no transitive supply-chain surface to
  audit.
- **Self-serve cloning** — voice and visual cloning are SDK calls, not a
  support ticket.
- **Security designed in** — pre-redacted audit events, short-lived tokens,
  and a NIST 800-53 control matrix, built for enterprise, HIPAA, and
  HITRUST deployments from the start.

## Quick start in the browser

Once a tag is pinned, jsDelivr serves the SDK straight from GitHub — no
`npm install`, no bundler:

<div data-nova-target="jsdelivr-quickstart" data-nova-label="Quick-start browser code example">

<!-- SDK version pin -- keep in sync with: intelligent-agents-sdk-site/src/assets/nova/connect.js
     (SDK_TAG constant) and docs-site-avatar/scripts/fetch-sdk.mjs (DEFAULT_TAG). -->
```html
<script type="module">
  import { KalturaAvatarSession } from 'https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.12.0/src/experience/index.js';
  // ... same API as the local examples in the repo's examples/ directory
</script>
```

</div>

Pin the tag for anything you ship — jsDelivr caches a tagged path forever, so
a pin is both stable and fast.

## Where to go next

<div data-nova-target="where-to-go-next" data-nova-label="Where to go next">

**New to the SDK?** Start with [Getting Started](/getting-started/) — from
zero to a talking AI avatar in about five minutes, once you have a Kaltura
account.

**Building a real app?** The How-to Guides walk through the specific
problems apps run into: driving your UI from the avatar, injecting
per-request data, choosing a voice-input mode, collecting structured form
data, and reimplementing the runtime from scratch.

**Need to look something up?** The Reference section is the complete,
austere dictionary of every endpoint, socket event, GenUI widget, and
architectural internal — API-Reference, Wire Protocol, GenUI Reference, and
the full use-case catalog.

**Want the bigger picture?** Platform Architecture, under Explanation,
covers the two backends, the live-video runtime, and how the pieces fit
together — read it when you want to understand *why*, not just *how*.

</div>

## Security and compliance

Zero runtime dependencies, short-lived tokens, pre-redacted audit events, and
a NIST 800-53 control matrix — designed for enterprise, HIPAA, and HITRUST
deployments. See [`SECURITY.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/SECURITY.md) in the repository for the full control
matrix.

## License

MIT. No Kaltura account or credentials are needed to read, fork, or build on
this SDK's source; a Kaltura account with the Agentic Avatar feature enabled
is needed to call the live APIs it wraps.

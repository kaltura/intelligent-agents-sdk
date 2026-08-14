---
layout: base.njk
title: Getting Started
description: Go from zero to a talking AI avatar in about five minutes.
eyebrow: Tutorial
---

# Getting Started — Your First Talking AI Avatar

We're going to take you from zero to a working, talking AI avatar in about
five minutes, once you have a Kaltura account — copy and paste the commands
as we go.

> **On Windows?** Run these commands in WSL2, Git Bash, or PowerShell — every
> command below is a plain `node`/`npm` call with no Bash-only syntax, so it
> works as-is in PowerShell too.

## What you need before you start

1. **A Kaltura account** with the Agentic Avatar feature enabled. No account
   yet? [Start a free trial](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial).
2. **Two pieces of information from your account** — we'll get them in Step 1:
   - your **Partner ID** (a number, like `1234567`)
   - your **Admin Secret** (a long string of letters and numbers)
3. **A computer with a terminal** and **Node.js 18+** installed. Check with
   `node --version`; install from [nodejs.org](https://nodejs.org) if it's
   missing.

That's it — we don't need to install anything from Kaltura.

## Step 1 — Get your credentials

Our Partner ID and Admin Secret are our keys to the system.

1. Log in to the **Kaltura Rich Media CMS** at [kmc.kaltura.com](https://kmc.kaltura.com)
   (or your account's custom URL, if your organization has one).
2. Go to **Settings → Integration Settings**.
3. Copy the **Partner ID** (shown at the top) and the **Administrator Secret**.

> **Keep the Admin Secret private.** It's like a password — never paste it
> into a public chat, a screenshot, or a file you might share.

## Step 2 — Set up the project

We'll clone the repository and install the quickstart's dependencies:

<div data-nova-target="getting-started-clone" data-nova-label="Clone and install commands">

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk/quickstart
npm install
```

</div>

Then we'll set our credentials for this shell session:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your_admin_secret_here
```

> **On PowerShell?** Use `$env:AGENTIC_PARTNER_ID="1234567"` instead of
> `export`.

## Step 3 — Create our own agent from scratch

This one command builds a brand-new agent — brain, face, voice, and all —
from a plain-English description:

```bash
node create-agent.mjs "A friendly yoga studio receptionist who helps people book classes and answers questions about memberships"
```

We'll see progress messages as it builds the brain, face, and voice. At the
end it sends a smoke-test message and prints the reply, plus the new IDs
(`configId`, `agentId`, `avatarId`, `widgetId`) we need to embed or extend
the agent.

## Step 4 — Talk to our agent again

`create-agent.mjs` already sent one smoke-test message for us. To send more,
we'll use the SDK's headless `converseOnce()` directly — save this as a
small script:

```js
import { Management } from '@kaltura/intelligent-agents/management';

const kaltura = new Management({
  partnerId: process.env.AGENTIC_PARTNER_ID,
  adminSecret: process.env.AGENTIC_ADMIN_SECRET,
});

const reply = await kaltura.converseOnce('<configId from Step 3>', 'Hello! What can you help me with?');
console.log(reply.text);
```

`converseOnce()` mints its own conversation token from the `configId` — our
admin secret never leaves the process.

## What we just did

<div data-nova-target="getting-started-success" data-nova-label="What we just did">

We created a complete agent — an intellect (brain) paired with an avatar
(face and voice) — and had a conversation with it, entirely from the command
line.

</div>

## Where to go next

| If you want to… | Read this |
|-----------------|-----------|
| See every kind of app you can build | [Use-Case Catalog](/reference/use-cases/) |
| Look up the exact API call for something | [API Reference](/reference/api-reference/) |
| Make the avatar drive your UI (slides, widgets, navigation) | [Client-Side Commands](/guides/client-commands/) |
| Put structured widgets on screen | [GenUI Reference](/reference/genui-reference/) |
| Understand how the whole system works under the hood | [Platform Architecture](/explanation/architecture/) |

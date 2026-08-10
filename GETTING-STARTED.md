# Getting Started — Your First Talking AI Avatar

This guide takes you from zero to a working, talking AI avatar in about 10 minutes — copy and paste the commands.

> **Windows?** Run these commands in WSL2, Git Bash, or PowerShell (the commands below are plain
> `node`/`npm` calls with no Bash-only syntax, so they work as-is in PowerShell too).

---

## Step 0 — see it work with zero credentials (under 2 minutes)

Before you get a Kaltura account, you can see the SDK actually run — offline, no network, no
secrets — using the same fakes the test suite is built on:

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk
npm test
```

That runs the full suite (unit + integration + e2e + evals) against `test/fakes/fetch.js`,
`test/fakes/socket.js`, and `test/fakes/rtc.js` — deterministic stand-ins for the real HTTP/socket/WebRTC
backends. It takes about 105 seconds on a typical machine. It's the fastest way to confirm the SDK
itself is sound on your machine before you touch a real account. Once you're ready to talk to a
real, live agent, continue to Step 1.

---

## What you need before you start

1. **A Kaltura account** with the Agentic Avatar feature enabled. No account yet? [Start a free trial →](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial)
2. **Two pieces of information from your account** (we'll get them in Step 1):
   - your **Partner ID** (a number, like `1234567`)
   - your **Admin Secret** (a long string of letters and numbers)
3. **A computer with a terminal** (the Terminal app on Mac, or any command line) and **Node.js 18+** installed. Check with `node --version`; install from [nodejs.org](https://nodejs.org) if missing.

That's it. You do **not** need to install anything from Kaltura.

---

## Step 1 — Get your credentials

Your Partner ID and Admin Secret are your keys to the system.

1. Log in to the **Kaltura Rich Media CMS** at [kmc.kaltura.com](https://kmc.kaltura.com) (or your account's custom URL if your organization has one).
2. Go to **Settings → Integration Settings**.
3. Copy your **Partner ID** (shown at the top) and your **Administrator Secret**.

> **Keep your Admin Secret private.** It's like a password. Never paste it into a public chat, a screenshot, or a file you might share.

---

## Step 2 — Set up the project

Clone the repository (skip this if you already did it in Step 0) and install the quickstart's dependencies:

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk/quickstart
npm install
```

Then set your credentials for this shell session:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your_admin_secret_here
```

> **Windows PowerShell?** Use `$env:AGENTIC_PARTNER_ID="1234567"` instead of `export`.

> **Prefer a file over exporting every time?** Create a `.env` file in the repo root (one directory
> up from `quickstart/`) with `AGENTIC_PARTNER_ID=...` and `AGENTIC_ADMIN_SECRET=...` on their own
> lines — `create-agent.mjs` reads it automatically if present. It's already covered by
> `.gitignore`, so it never gets committed.

---

## Step 3 — Create your own agent from scratch

This one command builds a brand-new agent — brain, face, voice, and all — from a plain-English description:

```bash
node create-agent.mjs "A friendly yoga studio receptionist who helps people book classes and answers questions about memberships"
```

This takes 1–3 minutes — you'll see progress messages as it builds the brain, face, and voice. At the
end it sends a smoke-test message and prints the reply, plus the new IDs (`configId`, `agentId`,
`avatarId`, `widgetId`) you need to embed or extend the agent.

> Building an agent by hand instead of via the one-line brief? See [API-REFERENCE.md](API-REFERENCE.md) → "Create an Agent".

---

## Step 4 — Talk to your agent again

`create-agent.mjs` already sent one smoke-test message for you. To send more, use the SDK's
headless `converseOnce()` directly — save this as a small script (or adapt `quickstart/create-agent.mjs`):

```js
import { Management } from '@kaltura/intelligent-agents/management';

const kaltura = new Management({
  partnerId: process.env.AGENTIC_PARTNER_ID,
  adminSecret: process.env.AGENTIC_ADMIN_SECRET,
});

const reply = await kaltura.converseOnce('<configId from Step 3>', 'Hello! What can you help me with?');
console.log(reply.text);
```

`converseOnce()` mints its own conversation token from the `configId` — the admin secret never
leaves your process. See [API-REFERENCE.md](API-REFERENCE.md) for threaded conversations, streaming,
and the full Management API surface.

---

## What's next?

You now know how to create an agent and talk to it. Here's where to go for more:

| If you want to… | Read this |
|-----------------|-----------|
| See every kind of app you can build (personalized greeters, memory agents, quizzes, video avatars, voice cloning…) | [API-REFERENCE.md](API-REFERENCE.md) → "Use-Case Catalog" |
| Look up the exact API call for something | [API-REFERENCE.md](API-REFERENCE.md) |
| Put a talking video avatar on a web page | [API-REFERENCE.md](API-REFERENCE.md) → "Use Case 12 — Anonymous End-User Embed" |
| Use your **own voice** for the avatar | [API-REFERENCE.md](API-REFERENCE.md) → "Use Case 9 — Custom Voice" |
| Use your **own face/portrait** for the avatar | [API-REFERENCE.md](API-REFERENCE.md) → "Use Case 13 — Custom Portrait Avatar" |
| Build a real app with the JavaScript SDK | [README.md](README.md) |
| Make the avatar drive your UI (slides, widgets, navigation) | [docs/CLIENT-COMMANDS.md](docs/CLIENT-COMMANDS.md) |
| Put structured widgets on screen (quizzes, carousels, code blocks) | [docs/GENUI-REFERENCE.md](docs/GENUI-REFERENCE.md) |
| Understand how the whole system works under the hood | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| See a complete browser example with a live avatar | [examples/browser-experience.html](examples/browser-experience.html) |
| See a complete avatar-guided slide deck | [examples/deck-presenter.html](examples/deck-presenter.html) |

---

## Common questions

**Do I need to keep the terminal open?** No. `create-agent.mjs` runs once and exits.

**Will this cost money / use my quota?** Conversations and avatar sessions use your Kaltura plan's quota. Creating agents/avatars is cheap, but clean up test ones you don't need — see `agents.delete()` / `avatars.delete()` in [API-REFERENCE.md](API-REFERENCE.md).

**How do I see everything I created?** Use the Management API's list calls:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const kaltura = new Management({ partnerId, adminSecret });
console.log(await kaltura.agents.list());
console.log(await kaltura.avatars.list());
```

**How do I label the agents I create so I can find mine later?** Tag the **agent** (not the
avatar). Pass `adminTags` (e.g. `["yoga-demo"]`) to `agents.create()`, then filter `agents.list()`
results client-side by that tag — there's no server-side agent filter today. Avatars do **not**
carry a tag field — `avatar/create` and `avatar/update` reject an `adminTags` property — so group by
tagging the parent agent instead.

**Can I use my own face?** Yes — both voice and face. Upload a portrait image via
`catalog.createVisual()` with an image file (or `catalog.importVoiceFromElevenLabs`/
`importVoiceFromCartesia` for a provider voice), then pass the returned `itemId` as `visualId` in
`avatars.create()`. The model animates your portrait at runtime — no ops involvement, no
pre-processing. The gap today is a video-clip ingest pipeline (a higher-fidelity model from a short
clip); image-based custom visuals work end-to-end self-serve.

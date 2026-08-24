# Getting Started — Your First Talking AI Avatar

This guide takes you from zero to a working, talking AI avatar in about 5 minutes, once you have
a Kaltura account — copy and paste the commands.

> **Windows?** Run these commands in WSL2, Git Bash, or PowerShell (the commands below are plain
> `node`/`npm` calls with no Bash-only syntax, so they work as-is in PowerShell too).

---

## What you need before you start

1. **A Kaltura account** with the Agentic Avatar feature enabled. No account yet? [Start a free trial →](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial)
2. **Two pieces of information from your account** (we'll get them in Step 1):
   - your **Partner ID** (a number, like `1234567`)
   - your **Admin Secret** (a long string of letters and numbers)
3. **A computer with a terminal** (the Terminal app on Mac, or any command line) and **Node.js 18+** installed. Check with `node --version`; install from [nodejs.org](https://nodejs.org) if missing.

That's it. You do **not** need to install anything from Kaltura.

---

## Step 1 — Get your credentials (~1 minute)

Your Partner ID and Admin Secret are your keys to the system.

1. Log in to the **Kaltura Rich Media CMS** at [kmc.kaltura.com](https://kmc.kaltura.com) (or your account's custom URL if your organization has one).
2. Go to **Settings → Integration Settings**.
3. Copy your **Partner ID** (shown at the top) and your **Administrator Secret**.

> **Keep your Admin Secret private.** It's like a password. Never paste it into a public chat, a screenshot, or a file you might share.

---

## Step 2 — Set up the project (~1 minute)

Clone the repository and install the quickstart's dependencies:

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

## Step 3 — Create your own agent from scratch (1–3 minutes)

This one command builds a brand-new agent — brain, face, voice, and all — from a plain-English description:

```bash
node create-agent.mjs "A friendly yoga studio receptionist who helps people book classes and answers questions about memberships"
```

You'll see progress messages as it builds the brain, face, and voice. At the
end it sends a smoke-test message and prints the reply, plus the new IDs (`configId`, `agentId`,
`avatarId`, `widgetId`) you need to embed or extend the agent.

> Building an agent by hand instead of via the one-line brief? See [API-REFERENCE.md](API-REFERENCE.md#phase-2--build).

---

## Step 4 — Talk to your agent again (~30 seconds)

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
leaves your process. See [API-REFERENCE.md](API-REFERENCE.md#phase-4--operate) for threaded
conversations, streaming, and the full Management API surface.

**Talking on behalf of a real, known user?** Mint the conversation token yourself with `userId`
instead of letting `converseOnce()` auto-mint an anonymous one — this binds the KS to that user so
per-user memory and analytics attribute the conversation correctly:

```js
const conv = await kaltura.sessions.createConversationToken({
  configId: '<configId from Step 3>',
  userId: 'learner-123',   // any stable id you use to identify this person
});
const reply = await kaltura.converseOnce('<configId from Step 3>', 'Hello again!', {}, conv);
```

`userId` is optional everywhere it's accepted — omit it and you get the same anonymous behavior
shown above. See [API-REFERENCE.md](API-REFERENCE.md#authentication) → "Bind a session to a real
end-user identity" for the full picture.

---

## What's next?

You now know how to create an agent and talk to it. Here's where to go for more:

| If you want to… | Read this |
|-----------------|-----------|
| See every kind of app you can build (personalized greeters, memory agents, quizzes, video avatars, voice cloning…) | [docs/USE-CASES.md](docs/USE-CASES.md) |
| Look up the exact API call for something | [API-REFERENCE.md](API-REFERENCE.md#contents) |
| Put a talking video avatar on a web page | [docs/USE-CASES.md](docs/USE-CASES.md) → UC-12 |
| Use your **own voice** for the avatar | [API-REFERENCE.md](API-REFERENCE.md#upload-a-custom-voice-clone) |
| Use your **own face/portrait** for the avatar | [API-REFERENCE.md](API-REFERENCE.md#upload-a-custom-visual-portrait--animated-avatar) |
| Build a real app with the JavaScript SDK | [README.md](README.md#quick-start) |
| Make the avatar drive your UI (slides, widgets, navigation) | [docs/CLIENT-COMMANDS.md](docs/CLIENT-COMMANDS.md) |
| Pause the avatar for a video/interactive element, then resume | [docs/PAUSE-RESUME-RECIPE.md](docs/PAUSE-RESUME-RECIPE.md) |
| Put structured widgets on screen (quizzes, carousels, code blocks) | [docs/GENUI-REFERENCE.md](docs/GENUI-REFERENCE.md) |
| Understand how the whole system works under the hood | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| See a complete browser example with a live avatar | [examples/browser-experience.html](examples/browser-experience.html) |
| See a complete avatar-guided slide deck | [examples/deck-presenter.html](examples/deck-presenter.html) |

---

## Common questions

**Do I need to keep the terminal open?** No — `create-agent.mjs` runs once and exits.

**Will this cost money / use my quota?** Conversations and avatar sessions use your Kaltura plan's quota. Creating agents/avatars is cheap, but clean up test ones you don't need — see `agents.delete()` / `avatars.delete()` in [API-REFERENCE.md](API-REFERENCE.md#management-operations).

**How do I see everything I created?** Use the Management API's list calls — `kaltura.agents.list()` and `kaltura.avatars.list()`. See [API-REFERENCE.md](API-REFERENCE.md#management-operations).

**How do I label the agents I create so I can find mine later?** Tag the **agent** (not the avatar) via `adminTags` on `agents.create()`, then filter `agents.list()` client-side. Details in [API-REFERENCE.md](API-REFERENCE.md#create-an-agent).

**Can I use my own face or voice?** Yes, both — see [API-REFERENCE.md](API-REFERENCE.md#upload-a-custom-visual-portrait--animated-avatar) and [→ Custom Voice](API-REFERENCE.md#upload-a-custom-voice-clone).

---

## Appendix — Verify your checkout offline (~2 minutes)

You don't need a Kaltura account to confirm the SDK runs correctly on your machine — run it
offline, no network, no secrets, using the same fakes the test suite is built on.

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk
npm test
```

That runs the full suite (unit + integration + e2e + evals) against `test/fakes/fetch.js`,
`test/fakes/socket.js`, and `test/fakes/rtc.js` — deterministic stand-ins for the real
HTTP/socket/WebRTC backends. It takes about 105 seconds on a typical machine.

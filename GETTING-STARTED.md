# Getting Started — Your First Talking AI Avatar

This guide takes you from zero to a working, talking AI avatar in about 10 minutes — copy and paste the commands.

> **Windows?** Run these commands in WSL2 or Git Bash. The Bash syntax doesn't work in PowerShell or CMD.

---

## What you need before you start

1. **A Kaltura account** with the Agentic Avatar feature enabled. No account yet? [Start a free trial →](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial)
2. **Two pieces of information from your account** (we'll get them in Step 1):
   - your **Partner ID** (a number, like `1234567`)
   - your **Admin Secret** (a long string of letters and numbers)
3. **A computer with a terminal** (the Terminal app on Mac, or any command line) and `curl` + `python3` + **Node.js 18+** installed. On macOS 12.3+ `python3` is no longer bundled — run `xcode-select --install` if it is missing. `curl` and `python3` are standard on Linux. Check Node with `node --version`; install from [nodejs.org](https://nodejs.org) if missing.

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

Clone the repository and move into its folder:

```bash
git clone https://github.com/kaltura/agentic-avatar-toolkit.git && cd agentic-avatar-toolkit
```

Then create your private credentials file:

```bash
cp .env.example .env
```

Open the new `.env` file in any text editor and fill in the two values from Step 1:

```
AGENTIC_PARTNER_ID=1234567
AGENTIC_ADMIN_SECRET=your_admin_secret_here
```

Save and close. The `.env` file stays on your computer and is never shared (it's automatically excluded from version control).

> **Tip:** Prefer not to save a file? You can paste your credentials directly into each command instead — see "Without a .env file" at the bottom.

---

## Step 3 — Check it works

Run this to generate a temporary login token called a **Kaltura Session** (KS for short):

```bash
node tools/session.mjs admin
```

If you see a long string of characters, you're connected. 🎉 If you see `{objectType:KalturaAPIException...}` instead, your Partner ID or Admin Secret is incorrect — double-check the values you copied from the Rich Media CMS. If you see an error about missing credentials, double-check Step 2.

---

## Step 4 (optional) — See what's available

Your account comes with ready-made faces ("visuals") and voices you can use. List them:

```bash
# See available faces
node tools/agentic.mjs catalog-list Visual | python3 -m json.tool

# See available voices
node tools/agentic.mjs catalog-list Voice | python3 -m json.tool
```

Each result has an `itemId` (you'll use these to build an avatar) and friendly details like name, hair color, and voice personality.

---

## Step 5 — Create your own agent from scratch

This one command builds a brand-new agent — brain, face, voice, and all — from a plain-English description:

```bash
node quickstart/create-agent.mjs \
  "A friendly yoga studio receptionist who helps people book classes and answers questions about memberships"
```

This takes 1–3 minutes — you'll see progress messages as it builds the brain, face, and voice. At the end it **talks back** to prove it's alive. The last line prints the new IDs (`cfg=…  agent=…  avatar=…  widget=…`).

The widgetId lets you embed the avatar on a public web page — see the What's next table for details.

> **To remove what you just created** (so your account stays tidy):
> ```bash
> # use the configId / agentId / avatarId printed at the end
> node tools/genie.mjs intellect-delete <cfg>
> node tools/agentic.mjs agent-delete <agent>
> node tools/agentic.mjs avatar-delete <avatar>
> ```

> Building an agent by hand? See [API-REFERENCE.md](API-REFERENCE.md) → "Create an Agent".

---

## Step 6 — Talk to an agent

Each agent has a **config ID** — a unique identifier for its brain configuration. You'll see it as `configId` in any JSON output. This grabs the first agent's config ID automatically and starts a chat:

```bash
CFG=$(node tools/agentic.mjs agent-list \
  | python3 -c "
import sys,json
objs=json.load(sys.stdin)
if not objs:
    print('No agents found — run Step 5 first',file=sys.stderr); sys.exit(1)
print(objs[0]['intellect']['configId'])")
node tools/genie.mjs converse-pretty "$CFG" "Hello! What can you help me with?"
```

You'll get the agent's reply back as text. Ask it anything — it remembers the conversation if you pass the same thread (more on that in [API-REFERENCE.md](API-REFERENCE.md)).

> **Tip:** to see all your agents and their config IDs, run `node tools/agentic.mjs agent-list | python3 -m json.tool`.

---

## What's next?

You now know how to list resources, talk to an agent, and create one. Here's where to go for more:

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

---

## Common questions

**Do I need to keep the terminal open?** No. Each command runs and finishes on its own.

**Will this cost money / use my quota?** Conversations and avatar sessions use your Kaltura plan's quota. Creating agents/avatars is cheap, but clean up test ones you don't need.

**I made a mess — how do I see everything I created?**

```bash
node tools/agentic.mjs agent-list | python3 -m json.tool      # all agents
node tools/agentic.mjs avatar-list | python3 -m json.tool     # all avatars
```

**How do I label the agents I create so I can find mine later?** Tag the **agent** (not
the avatar). When you create an agent you can pass `adminTags` (e.g. `["yoga-demo"]`) and
later pick your own out of the list. Avatars do **not** carry a tag field — `avatar/create`
and `avatar/update` reject an `adminTags` property — so group/identify by tagging the parent
agent instead. There is no server-side agent filter today, so `agent-list` returns everything
and you match the tag yourself:

```bash
node tools/agentic.mjs agent-list > /tmp/agents.json
python3 -m json.tool /tmp/agents.json | grep -B2 yoga-demo
```

**Can I use my own face?** Yes — both voice and face. Upload a portrait image with `node tools/agentic.mjs visual-upload` (or `POST catalog-item/create` with an image file), then pass the returned `itemId` as `visualId` in `avatar/create`. The model animates your portrait at runtime — no ops involvement, no pre-processing. The gap today is a video-clip ingest pipeline (higher-fidelity model from a short clip); image-based custom visuals work end-to-end self-serve.

---

## Without a .env file (pass credentials inline)

Every command also reads your credentials from the environment, which is handy for testing different accounts — export them, then run any command:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your_secret
node tools/session.mjs admin
```

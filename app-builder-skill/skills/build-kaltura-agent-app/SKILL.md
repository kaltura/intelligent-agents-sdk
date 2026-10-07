---
name: build-kaltura-agent-app
description: Guides building an app with Kaltura AI agents and avatars using the @kaltura/intelligent-agents SDK. Use when the user wants to add a Kaltura avatar, talking avatar, AI agent, chat widget, voice or video agent, or deck presenter to an app, or asks to learn, teach, or train Claude on the Kaltura agents SDK, Management, KalturaAvatarSession, provisioning an agent, partner id or admin secret. Not for uploading or playing Kaltura videos, plain KMC or REST API work, or other vendors' SDKs.
license: MIT
---

# Build an app with Kaltura agents

The official docs are the source of truth. This skill only gives the order of steps and points to the docs. Do not answer from memory.

## Rule 0: read before you write

1. Fetch `https://kaltura.github.io/intelligent-agents-sdk/llms.txt` with your web fetch tool. It lists every docs page with a one-line summary. With no fetch tool, run `curl -sL <url>` instead.
2. Fetch the pages you need the same way, using the table in `references/paths.md`.
3. Read example code from `node_modules/@kaltura/intelligent-agents/examples/` after Step 3.
4. Use only method, class and option names you saw in the docs or the installed package. If you cannot find one, say so and ask. Never guess a name.
5. Suggest only what the docs recommend for building agents.

## Step 0: check the machine

Run both and report the versions.

```bash
node -v
git --version
```

Node 18 or newer is required. If it is missing or older, tell the user to install the current LTS from nodejs.org and stop until they have.

## Step 1: credentials

The user needs a Kaltura account with the Agentic Avatar feature enabled, a Partner ID and an Admin Secret. Walk them through it in plain words:

1. Log in to the Kaltura Rich Media CMS (kmc.kaltura.com, or their organization's own URL).
2. Open Settings, then Integration Settings.
3. Copy the Partner ID and the Administrator Secret.

Rules for the secret:

- The user types it into a `.env` file themselves. Never ask them to paste it into the chat, and never print it.
- Add `.env` to `.gitignore` before the file exists.
- Ask which region the account is in (US is the default). Read "Regions and base URLs" on the authentication page and set the region as the docs show.
- No account yet: point to the free trial link in the Getting Started page.

## Step 2: pick a path

Ask one question. Offer the four paths in plain words, and recommend A if the user is unsure.

| Path | The user wants |
|---|---|
| A. Server agent | An agent that answers from code, no screen |
| B. Chat widget | Text chat on a web page, no video |
| C. Avatar | A talking face with voice, on a web page |
| D. Deck presenter | An avatar that walks through slides |

Paths B to D need a small server that holds the Admin Secret and gives each visitor a short-lived token.

## Step 3: install the SDK

In the user's project (run `npm init -y` first if there is no `package.json`):

```bash
npm install "github:kaltura/intelligent-agents-sdk#semver:^1"
```

Then print the installed version from `node_modules/@kaltura/intelligent-agents/package.json`. For browser code loaded from a CDN, pin jsDelivr to `v` plus that version, as the docs show.

## Step 4: build

1. Open the user's path in `references/paths.md`.
2. Read the docs pages it names.
3. Adapt the example it names. Replace the example's relative `../src/...` imports with the package imports the docs show.
4. Keep new files small and explain each one in a sentence.

## Step 5: verify

1. Run it against the real account.
2. For browser work, serve over `localhost` or HTTPS so microphone and camera work.
3. On failure, print the error `code` and message, then look the code up in the docs before changing anything.
4. Tell the user exactly how to try it, and what a working result looks like.

## Hard rules

These are reminders. The docs page behind each link is the source.

- The Admin Secret stays on the server. Never put it in browser code, a public repo or a log. [Authentication](https://kaltura.github.io/intelligent-agents-sdk/reference/api/authentication/)
- Give each end user a scoped, short-lived token with a per-user id. [Authentication](https://kaltura.github.io/intelligent-agents-sdk/reference/api/authentication/)
- An agent that calls tools needs `kaltura_genie_experiences` set to `'off'` when it is created. Setting it later does not take effect for about a day. [Client commands](https://kaltura.github.io/intelligent-agents-sdk/guides/client-commands/)
- `csv` and `code` tools must be enabled for the account first. Offer an `api` tool when they are not. [Tools and secrets](https://kaltura.github.io/intelligent-agents-sdk/reference/api/build/tools-and-secrets/)
- Register event listeners before calling `connect()`. [SDK reference](https://kaltura.github.io/intelligent-agents-sdk/reference/sdk-reference/)
- Show users that they are talking to an AI avatar. [SDK reference](https://kaltura.github.io/intelligent-agents-sdk/reference/sdk-reference/)

If a request is outside what the docs cover, or the account lacks a feature, say what you observed (for example "the feature must be enabled for your account") and ask the user to contact their Kaltura representative.

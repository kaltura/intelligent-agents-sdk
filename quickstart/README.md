# Quickstart

The commands behind [GETTING-STARTED.md](../GETTING-STARTED.md), the canonical path from zero to a talking agent. Start there for the full walkthrough (credentials, what each step does, what's next); this file is a pointer for when you already know the drill.

## Run

```bash
cd quickstart
npm install
export AGENTIC_PARTNER_ID=your_partner_id
export AGENTIC_ADMIN_SECRET=your_admin_secret
node create-agent.mjs "A friendly yoga-studio receptionist"
```

`npm install` here installs the quickstart's own dependencies (its `package.json`, separate from the SDK) — the `@kaltura/intelligent-agents` package itself stays zero-dependency.

> **Windows?** Use PowerShell: replace `export VAR=value` with `$env:VAR="value"`. Or put both vars in a `.env` file in the repo root and they are picked up automatically.

The script provisions a complete agent (brain + face + voice), sends it a test message, and prints the response. It takes 1–3 minutes — you will see progress as it builds.

## What it does

1. Provisions a full agent from your brief (creates intellect + avatar + agent)
2. Sends a test message via the headless conversation path
3. Prints the agent reply, plus the IDs you need to embed or extend the agent

## Next steps

| Goal | Where to go |
|------|-------------|
| Embed a live talking avatar in a web page | [docs/USE-CASES.md](../docs/USE-CASES.md) → UC-12 |
| Use your own voice | [API-REFERENCE.md](../docs/api/design.md#upload-a-custom-voice-clone) |
| Use your own portrait | [API-REFERENCE.md](../docs/api/design.md#upload-a-custom-visual-portrait--animated-avatar) |
| Drive your UI from the avatar (slide navigation etc.) | [docs/CLIENT-COMMANDS.md](../docs/CLIENT-COMMANDS.md) |

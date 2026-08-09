# Quickstart

The fastest path from zero to a talking agent — pure Node.js, no shell scripts, works on Mac, Windows, and Linux.

## Prerequisites

- Node.js 18 or later: `node --version`
- A Kaltura account: [start a free trial](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial)
- Your Partner ID and Admin Secret from [kmc.kaltura.com](https://kmc.kaltura.com) → Settings → Integration Settings

## Run

```bash
cd quickstart
npm install
export AGENTIC_PARTNER_ID=your_partner_id
export AGENTIC_ADMIN_SECRET=your_admin_secret
node create-agent.mjs "A friendly yoga-studio receptionist"
```

> **Windows?** Use PowerShell: replace `export VAR=value` with `$env:VAR="value"`.
> Or put both vars in a `.env` file in the repo root and they are picked up automatically.

The script provisions a complete agent (brain + face + voice), sends it a test message, and prints the response. It takes 1–3 minutes — you will see progress as it builds.

## What it does

1. Provisions a full agent from your brief (creates intellect + avatar + agent)
2. Sends a test message via the headless conversation path
3. Prints the agent reply, plus the IDs you need to embed or extend the agent

## Next steps

| Goal | Where to go |
|------|-------------|
| Embed a live talking avatar in a web page | [API-REFERENCE.md](../API-REFERENCE.md) → Use Case 12 |
| Use your own voice | [API-REFERENCE.md](../API-REFERENCE.md) → Use Case 9 |
| Use your own portrait | [API-REFERENCE.md](../API-REFERENCE.md) → Use Case 13 |
| Drive your UI from the avatar (slide navigation etc.) | [docs/CLIENT-COMMANDS.md](../docs/CLIENT-COMMANDS.md) |

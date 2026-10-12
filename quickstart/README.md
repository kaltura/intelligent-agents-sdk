# Quickstart

Creates an agent from a one-line brief, sends it a test message and prints the reply. The full walkthrough is in [GETTING-STARTED.md](../GETTING-STARTED.md).

```bash
cd quickstart
npm install
export AGENTIC_PARTNER_ID=your_partner_id
export AGENTIC_ADMIN_SECRET=your_admin_secret
node create-agent.mjs "A friendly yoga studio receptionist who helps people book classes and answers questions about memberships"
```

`npm install` links the SDK from the parent folder (`file:..`). Credentials: [GETTING-STARTED.md Step 2](../GETTING-STARTED.md#step-2-set-up-the-project-1-minute) covers `export`, PowerShell and the `.env` option.

The script takes 1 to 3 minutes and prints one status line per step:

1. Creates the intellect, avatar and agent, with a silent opening (`openingPhrase: SILENT_OPENING`).
2. Sends a test message through the headless conversation path.
3. Prints the reply and the IDs you need to embed or extend the agent.

The silent opening means the browser sends the first turn: [docs/START-THE-CONVERSATION.md](../docs/START-THE-CONVERSATION.md).

# Check your agent with the doctor: a first-timer's guide

The doctor looks at your agents and tells you what is set up wrong, in plain words, with the fix next to each problem. This guide is for you if you are new to Kaltura agents, or new to the command line. It takes about 5 minutes.

## When to run it

Run the doctor when:

- Your agent behaves oddly: it mishears people, speaks in the wrong language, stays silent, or answers slowly.
- You finished building an agent and want a check before you show it to anyone.
- You changed a setting and want to know nothing else broke.

`npm run doctor` on its own only reads. It changes nothing in your account. Two options below do change things, and each one says so.

## What you need

| You need | Where to get it |
|---|---|
| The project on your computer | Done in [Getting Started, step 2](../GETTING-STARTED.md#step-2-set-up-the-project-1-minute) |
| Node.js 18.3 or newer | Check with `node --version`. Get it at [nodejs.org](https://nodejs.org) |
| Your Partner ID and Admin Secret | [Getting Started, step 1](../GETTING-STARTED.md#step-1-get-your-credentials-1-minute) |

Your Admin Secret is a password. Keep it out of screenshots and chats.

## Run it

1. Open a terminal in the project folder (the one that holds `package.json`, not `quickstart/`).
2. Create a file named `.env` (the name starts with a dot) in that folder with a text editor. Put your credentials in it, one per line, with no spaces around `=`:

   ```
   AGENTIC_PARTNER_ID=1234567
   AGENTIC_ADMIN_SECRET=your_admin_secret_here
   ```

3. Run:

   ```bash
   npm run doctor
   ```

You do not need `npm install` for this command.

Partner outside the US? This command checks the US region only. Call the doctor from code instead, with `new Management({ partnerId, adminSecret, region: 'frp2' })` for the EU (Frankfurt) region. See [Doctor](DOCTOR.md).

To check one agent only, add its id:

```bash
npm run doctor -- --agent 98765
```

## Read the result

A problem looks like this:

```
[ERROR] asr_language_mismatch (agent 98765, intellect 4321)
  asr.language is "en", but the intellect forces replies in "es". Speech in that language is recognized as "en".
  fix: Set the recognition language to match: await mgmt.agents.update(...)

target prod: 1 error, 0 warn, 0 info.
checked: agents 3, rules 1
```

`prod` is your live Kaltura account in the US region. The doctor only reads from it. ASR means speech recognition, and the intellect is your agent's set of instructions. The `fix:` line is code for a developer. If that is not you, send it to one.

Each problem has four parts:

| Part | Meaning |
|---|---|
| `[ERROR]` | How serious it is |
| `asr_language_mismatch` | The problem's name. Look it up in [Finding codes](DOCTOR.md#finding-codes) |
| The sentence under it | What is wrong |
| `fix:` | What to change |

| Level | What to do |
|---|---|
| `ERROR` | Something does not work as you set it up. Fix it first |
| `WARN` | A likely mistake. Check it |
| `INFO` | Not a fault. Read it and move on |

The line that starts with `target prod:` counts the problems. The `checked:` line shows how much the doctor looked at. `1 error, 0 warn, 0 info` means one thing to fix.

No problems? The `target prod:` line says `0 error, 0 warn, 0 info`. Your setup looks right.

## Find the cause from what you see

Match what you notice to a problem name, then find that name in the report. The full list is in [Start from a symptom](DOCTOR.md#start-from-a-symptom).

| What you notice | Look for |
|---|---|
| People speak Spanish and the agent mishears them | `asr_language_mismatch` |
| The agent talks but the words sound wrong | `voice_reply_language_mismatch` |
| A long pause before the avatar speaks | `latency_thinking` |
| The opening line is missing | `opening_phrase_may_render_empty` |
| The avatar does not show up | `avatar_not_found` |

## Let the doctor fix it

One problem is safe to fix automatically: a wrong speech recognition language (`asr_language_mismatch`). The other fixes need your judgment, so you make them yourself.

1. See what the doctor would change. This writes nothing:

   ```bash
   npm run doctor -- --fix
   ```

2. Happy with the plan? Apply it. This writes the change to your agent:

   ```bash
   npm run doctor -- --fix --apply --code asr_language_mismatch
   ```

3. Run `npm run doctor` again. The problem is gone.

The first step prints `dry run, nothing written` above the plan. If it prints `fixes: none available.`, there is nothing to fix automatically. If it prints neither line, stop and check the command.

## Time a real answer

If your agent feels slow, let the doctor ask it one real question and time the answer:

```bash
npm run doctor -- --probe --agent 98765
```

The result shows how long the first words took and how long the whole answer took. This sends one real message to your agent. If your account has lifecycle rules that react to messages, such as sending an email, the doctor stops and lists them. Add `--allow-side-effects` only if you accept that those rules run.

## Hide a problem you accept

Some findings are fine for your agent. Hide them with a file, for example `ignore.json`:

```json
[{ "code": "latency_thinking", "agentId": "98765" }]
```

```bash
npm run doctor -- --ignore-file ignore.json
```

## If something goes wrong

| You see | Do this |
|---|---|
| `missing AGENTIC_PARTNER_ID` | Check the `.env` file is in the project folder and has both lines |
| `doctor failed (...)` | Check the Partner ID and Admin Secret for typos |
| `npm: command not found` | Install Node.js from [nodejs.org](https://nodejs.org) |
| The result is long and you want one agent | Add `--agent <id>` |

## Use it in your own project

Built your app with `npm install` instead of the cloned project? The command above is not in that package. Call the doctor from code. See [Doctor](DOCTOR.md).

## Where next

| Goal | Read |
|---|---|
| Every problem name and what it means | [Doctor](DOCTOR.md#finding-codes) |
| Warnings that appear during a live conversation | [Turn warnings](architecture-reference/resilience-and-failure-handling.md#turn-warnings) |
| Spoken languages | [Languages](LANGUAGES.md) |

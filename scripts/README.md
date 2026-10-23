> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](../docs/contributor/README.md).

# Harnesses and verification scripts

Everything in `scripts/` is a verification entry point. Nothing here ships in the package: `src/` is the SDK, these are the checks that prove it works.

Three tiers, cheapest first. Run the tier that matches what you changed.

| Tier | What it proves | Needs | Entry point |
|---|---|---|---|
| 1. Offline tests | Logic, contracts, event order, edge cases | Node only | `npm test` |
| 2. Real browser, offline | Real WebRTC, real media elements, real autoplay policy | Playwright browsers | `npm run verify:avatar-media`, `npm run verify:noise-suppressor` |
| 3. Live backend | The SDK against the actual server | Partner credentials | `npm run live-verify:<name>` |

Tier 1 and 2 run on every PR. Tier 3 runs on PRs too, but only some of it (see [What CI runs](#what-ci-runs)).

## Tier 1: offline tests

Plain `node:test`, no browser, no network. Layers live under `test/unit`, `test/integration`, `test/e2e`, `test/evals`.

```bash
npm test          # all layers
npm run test:ci   # same, with coverage thresholds and a junit report
```

## Tier 2: real browser, offline

Two harnesses drive a real browser engine against a local page. No credentials, no network, no sound: the WebRTC legs are loopback peers inside the page, signalling is a fake socket, and WHEP is an injected `fetch`.

| Script | Page | Covers |
|---|---|---|
| `verify-avatar-media.mjs` | `../test/browser/avatar-media.html` | The merged-stream media path (`src/experience/avatar-media.js`): attach, swap, mute, mixing, recording, autoplay, teardown, leaks |
| `verify-noise-suppressor.mjs` | `verify-noise-suppressor.html` | The AudioWorklet noise gate in a real audio graph |

```bash
npm run verify:avatar-media                        # default engine (chromium)
VERIFY_BROWSER=webkit npm run verify:avatar-media  # chromium | firefox | webkit
VERIFY_AVATAR_MEDIA_ONLY=shapes-simple,swaps npm run verify:avatar-media
```

`verify-avatar-media.mjs` writes `.harness-output/avatar-media-<engine>.json` (gitignored, regenerated every run). `verify-noise-suppressor.mjs` only prints its result.

Adding or renaming a scenario in `avatar-media.html` means updating `EXPECTED_CELLS` in `verify-avatar-media.mjs` too, and an engine that cannot run a check has to be listed in `ALLOWED_SKIPS`. [test/browser/README.md](../test/browser/README.md) is the guide for that page.

## Tier 3: live backend

Every `live-verify-*.mjs` script talks to a real deployment with real credentials. They provision throwaway objects, assert what a caller observes, and clean up after themselves. The scripts that drive a browser (`live-verify-browser`, `live-verify-avatar-media`, `live-verify-session-complete` and the kickoff-based ones) need `npx playwright install chromium` on a fresh machine. Without it they fail with a missing `chromium_headless_shell`.

### Credentials

Drop a `.env` in the repo root (or export the vars). Nothing here reads a committed file, and no script ever writes a credential to an artifact.

Every script picks its backend the same way, through `lib/target.mjs`. By default it runs against production with two vars:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your-admin-secret
```

Use `prod` unless you have access to another environment. Environments such as the QA target `nvq2` are open to Kaltura employees and certified partners only. Set `TARGET` to use one. The scripts built on `live-verify-kickoff-shared.mjs` take the same value as `--env`, and `live-verify-mcp.mjs` takes it as `--target` (default `nvq2`).

| `TARGET` | Credentials | URLs |
|---|---|---|
| `prod` (default) | `AGENTIC_PARTNER_ID`, `AGENTIC_ADMIN_SECRET` | `REGIONS.nvp1` |
| `<name>` or `<name>:<account>` | `<NAME>_PARTNER_ID_<account>`, `<NAME>_ADMIN_SECRET_<account>` (account defaults to `1`), or (account `1` only) `<NAME>_PARTNER_ID`, `<NAME>_ADMIN_SECRET`, or `<NAME>_AGENTIC_PARTNER_ID`, `<NAME>_AGENTIC_ADMIN_SECRET` | `<NAME>_AGENTIC_API_URL`, `<NAME>_GENIE_URL`, `<NAME>_KALTURA_API_ENDPOINT`, and `<NAME>_MESSAGING_URL` if set |

`<name>` is lowercase letters and digits; `<NAME>` is the same text in upper case. A named target reads the repo-root `.env` and then the `.env` one level above the repo. Example: `TARGET=eu` reads `EU_PARTNER_ID_1`, `EU_ADMIN_SECRET_1`, `EU_AGENTIC_API_URL`, `EU_GENIE_URL`, `EU_KALTURA_API_ENDPOINT`; `TARGET=eu:2` swaps in the `_2` credential pair. A missing var exits 1 before any network call, and the message names the var, never a value.

The resolved target's `fetch` refuses any host outside the target's own URLs. So a named target without `<NAME>_MESSAGING_URL` fails `emailTemplates.*` calls instead of reaching the production messaging host. Get a partner id and admin secret from Kaltura Rich Media CMS → Settings → Integration Settings.

`live-verify-feedback-flow.mjs` and `live-check-feedback-unfiltered.mjs` can also run a second target, `alt`, read from `ALT_*` vars with the same names as above. They run it when any `ALT_` var is set.

`live-verify-regions.mjs` needs no credentials. It sends one unauthenticated request to every non-null base URL in `REGIONS` and checks that each host answers over TLS with the same status and content type as nvp1. Run it after changing `REGIONS`.

The two Salesforce scripts need a Salesforce Developer Edition org or sandbox (`SALESFORCE_INSTANCE_URL`, `SALESFORCE_ACCESS_TOKEN`). They require an `https:` URL on a `.salesforce.com` or `.force.com` host, and exit 0 with a "skipped" message when the variables are missing. `live-verify-salesforce-lead.mjs` is the exception to the partner-credentials rule: it sends nothing to the Kaltura backend and checks Salesforce itself and the SDK's request shapes. `live-verify-salesforce-agent.mjs` also needs partner credentials and a `TARGET`, and runs real conversations. It stores the token as a write-only agent secret and deletes the agent and tool at the end.

### Which script to run

| Script | Covers |
|---|---|
| `live-verify.mjs` | Smoke test: admin token → intellect → conversation token → one turn → delete |
| `live-verify-matrix.mjs` | Runs the scripts above on every target, one at a time, and prints one table (script × target). `--targets prod,nvq2:1` (default, needs `nvq2` access; pass `--targets prod` without it), `--scripts a,b`, `--out DIR`, `--list`. Logs go to `DIR/<target>/<script>.log`. A target without credentials fails every script. Exits 1 on any non-pass |
| `live-verify-kickoff.mjs` | Every silent-opening + `kickoff` scenario, one fresh browser context each |
| `live-verify-connect-timing.mjs` | Startup KPIs: time to `connect()`, first video frame, first audio, first agent words |
| `live-verify-startup-faults.mjs` | `connect()` under client-side faults injected in the browser (nothing is broken on the server): a WHEP POST that answers 3.5 s late, is reset, answers 503, 404 or 409, a join that times out, and an answer whose media address is unreachable (`ice_failed`). Asserts the connect result, the retry count, `error.phase` and `retryable` |
| `live-verify-reconnect.mjs` | Recovery after the connection is lost, with faults injected in the browser: the avatar video peer closed (re-subscribe within 3 s), both peers closed (session rebuild, two open peers), a re-subscribe answered 404 (new avatar session on the same socket), and the browser offline for 6 s (connected again within 3 s of the network returning) |
| `live-verify-unload.mjs` | Closing the page while connected, and while `connect()` runs, leaves no viewer attached to the avatar session on the server. The check is made from Node after the close |
| `live-verify-prepare.mjs` | `session.prepare()`: joins ahead of `connect()` with state still `idle`, `connect()` reuses the socket (one `join`) and has no join phase left and its best run is faster than the plain best run by at least half of the plain run's socket and join time, and an unused prepared socket expires with `prepare_expired` |
| `live-verify-opening-phrase.mjs` | `provision()` writes the opening phrase to the intellect only, a Jinja2 `{% if %}` phrase renders per session from `requestVars`, and `SILENT_OPENING` on the intellect alone gives a silent opening turn |
| `live-verify-browser.mjs` | Browser smoke test: real WHEP downlink, real WebRTC, real media element |
| `live-verify-avatar-media.mjs` | The merged-stream media path against a real downlink |
| `live-verify-session-complete.mjs` | The `session_completed` signal and its presence mechanism |
| `live-verify-context-fields.mjs` | `contextId`/`contextType` actually reach the prompt at runtime |
| `live-verify-request-vars.mjs` | Every documented `request_vars` behavior over `converseOnce` |
| `live-verify-site-nav.mjs` | The `go_to` contract end to end |
| `live-verify-salesforce-lead.mjs` | `salesforceLeadUpsert` against a Salesforce dev org or sandbox: create, update, two Leads with one email, missing field, invalid email, bad token, cleanup. Needs `SALESFORCE_INSTANCE_URL` and `SALESFORCE_ACCESS_TOKEN`, prints `skipped` without them. Talks to Salesforce only, no Kaltura backend |
| `live-verify-salesforce-agent.mjs` | Seven scripted conversations with a real agent that has `salesforceLeadUpsert`: full data, missing company, duplicate email, invalid email, visitor refuses, two Leads with one email, expired token. Each outcome is checked with a SOQL query. `SALESFORCE_REVOKE_TOKEN=1` revokes the real token for the expiry case, so run it last |
| `live-verify-mcp.mjs` | `setMcpServers`/`describe` end to end against a CI-hosted reference MCP server, exposed through a tunnel. Takes `--target` and `--phase=provision\|verify\|cleanup`. See the script header |
| `live-verify-session-types.mjs` | What each token kind can reach: own vs other users' threads, OVP reach, no-userId and widget shared identity, agent persona, per-user `appInit`, `revoke()`. `--skip-revoke` skips the revoke check. `--with-share` also runs the `messages.share` success path, which leaves an undeletable clone per run: use it only after a change to `messages.share` |
| `live-verify-thread-access.mjs` | A token for one user sending another user's `threadId`: `KalturaChatSession` and `conversations.send` reject with `thread_access_denied`, `onErrorSegment: 'return'` returns the refusal in `result.errors`, `'warn'` emits `warning`, and the owner's thread keeps working. Uses `TARGET`, one throwaway intellect and one thread, deleted at the end |
| `live-verify-set-forced-language.mjs`, `live-verify-force-language.mjs` | A forced language changes the reply, not just storage |
| `live-verify-capabilities.mjs` | Capability resolution plus the Lifecycle domain |
| `live-verify-agents.mjs`, `live-verify-avatars.mjs`, `live-verify-catalog.mjs`, `live-verify-tools.mjs`, `live-verify-skills.mjs`, `live-verify-knowledge.mjs`, `live-verify-intellects-conversations.mjs`, `live-verify-threads-messages-feedback.mjs`, `live-verify-conversation-avatar-surface.mjs` | The write path of one management resource each |
| `live-verify-authoring.mjs` | Conditions on skills, prompt blocks and tools (the grammar the server accepts, one scratch intellect per expression), prompt block types, the `var` tool (int type, later value wins, skill and tool conditions that read it), `{arg}` placeholders in an `api` tool url, body, headers and params, shared skills (list, attach, refused get/update/delete, unknown id), the doctor findings for a saved templated condition, the server's empty reply to one, and read-back of unset fields as `null`, and `tool_ids` read back as `{id, condition}` with a per-attachment condition. Uses `TARGET`, scratch intellects, tools and skills, all deleted at the end |
| `live-verify-avatar-flag.mjs` | `sys__avatar_enabled` is true in a browser avatar session and false in a plain conversation, for a prompt block, a compound condition, a skill and a tool, and, with `--share`, that `sys__avatar_share_screen_enabled` flips when a simulated screen share runs. Uses `TARGET`, a throwaway agent and a headless browser, all removed at the end |
| `live-verify-lifecycle-audit.mjs` | `lifecycle.audit`, `doctor` and `intellectConfig.audit` report the expected findings for planted rule defects and none for a clean set, and `lifecycle-audit.mjs` exits 0, 1 and 2 as documented. Scoped to one throwaway agent. Covers the no-messaging-host skip on named targets |
| `live-verify-intellect-config.mjs` | Every `intellectConfig` setter on one scratch intellect, deleted at the end |
| `live-verify-knowledge-kms.mjs` | Linking a real Knowledge record to an intellect, and the linkage and status reads that depend on it |
| `live-verify-feedback-flow.mjs` | A real conversation, feedback on a reply, then read-back through `feedback.list` and `messages.list`. Waits 5 minutes. Can run a second target, `alt` |
| `live-check-feedback-unfiltered.mjs` | Read-only: does an unfiltered feedback read return anything for this partner. Can run a second target, `alt` |
| `live-verify-regions.mjs` | Every `REGIONS` host answers over TLS like nvp1. No credentials |
| `live-verify-threads-messages-feedback.mjs --with-share` | Also runs the `messages.share` step (step 6), which leaves an undeletable clone per run. Off by default: use it only after a change to `messages.share` |

Every one of these has an `npm run live-verify:<name>` script except `live-verify.mjs` and `live-verify-mcp.mjs` (CI runs both with `node`). Five have no npm script and no CI job. Run them with `node scripts/<name>.mjs`: `live-verify-intellect-config.mjs`, `live-verify-knowledge-kms.mjs`, `live-verify-feedback-flow.mjs`, `live-check-feedback-unfiltered.mjs`, `live-verify-thread-access.mjs`. Five more have an npm script but no CI job: `live-verify-force-language.mjs`, `live-verify-regions.mjs`, `live-verify-matrix.mjs`, `live-verify-salesforce-lead.mjs` and `live-verify-salesforce-agent.mjs`. Run them by hand, for example `npm run live-verify:regions`.

### Lifecycle audit CLI

`lifecycle-audit.mjs` (`npm run audit:lifecycle`) is a tool, not a test. It is read-only. It uses the same `TARGET` rules as the live scripts. Finding codes: [Audit your rules](../docs/lifecycle/README.md#audit-your-rules).

```bash
npm run audit:lifecycle -- [--agent <id>]... [--doctor] [--json] [--fail-on warn|error]
```

| Flag | Effect |
|---|---|
| `--agent <id>` | Check only that agent and the rules that run for it. Repeatable |
| `--doctor` | Also audit each agent's intellect and list unused insight settings and templates |
| `--json` | Print `{target, findings, summary, checked, skipped}` |
| `--fail-on warn\|error` | Lowest severity that gives exit code 1. Default `error` |

Exit code 0: nothing at or above `--fail-on`. 1: something is. 2: usage, credentials or request error. Secret values are never printed.

Read the header comment of a script before running it. Each one states what it asserts and why that coverage exists.

Four helper modules are not scripts and are never run directly: `lib/target.mjs` (the backend target resolver above), `live-verify-kickoff-shared.mjs` (CLI/env parsing, throwaway agent, server, browser, report), `live-verify-silent-mic-shared.mjs` (a silent WAV for `--use-file-for-fake-audio-capture`, so the fake mic's tone is not transcribed as invented user speech), and `live-verify-hooks-shared.mjs` (a bounded timeout around the page-side `window.test*` hooks, so a hook that never settles fails with a diagnostic instead of hanging the job).

### Flags

Nine scripts take the CLI flags below: `live-verify-kickoff.mjs`, `live-verify-connect-timing.mjs`, `live-verify-opening-phrase.mjs`, `live-verify-session-types.mjs`, `live-verify-startup-faults.mjs`, `live-verify-reconnect.mjs`, `live-verify-unload.mjs`, `live-verify-prepare.mjs` and `live-verify-avatar-flag.mjs` (they share `live-verify-kickoff-shared.mjs`). `live-verify-mcp.mjs` takes its own flags, listed in its header. Every other script is configured by env vars alone.

Shared by all nine (`live-verify-session-types.mjs` drives no browser, so it ignores `--browser`, `--headed` and `--kickoff`; `live-verify-avatar-flag.mjs` never sends a kickoff, so it ignores `--kickoff`):

| Flag | Effect |
|---|---|
| `--env prod\|<name>[:<account>]` | Backend to run against, same values as `TARGET`. Default `prod`. See the table above |
| `--env-file PATH` | Read env vars from `PATH` instead of `./.env` |
| `--browser chromium\|chrome\|firefox\|webkit` | Engine. `chrome` is the installed Google Chrome, always headed, audio audible |
| `--headed` | Show the browser window |
| `--kickoff TEXT` | Override the kickoff text |
| `--out DIR` | Artifact directory. Default `live-verify-artifacts/` |
| `--keep` | Do not delete the throwaway agent at the end |
| `--agent-json PATH` | Reuse the agent described in `PATH` (`{configId, widgetId}`, plus `agentId` for `live-verify-session-types.mjs`) instead of provisioning one. Deletes nothing |
| `--skip-revoke` | `live-verify-session-types.mjs` only: skip the `revoke()` check |

`live-verify-startup-faults.mjs`, `live-verify-reconnect.mjs`, `live-verify-unload.mjs`, `live-verify-prepare.mjs` and `live-verify-avatar-flag.mjs` take `--only IDS` too. `live-verify-avatar-flag.mjs` also adds `--share` (run the screen-share checks A5 and A6), and `live-verify-prepare.mjs` adds `--runs N` (alternating plain and prepared pairs, default 3).

`live-verify-kickoff.mjs` and `live-verify-opening-phrase.mjs` add `--only IDS` (run these scenario ids only) and `--dump-events` (write the page's full event log for every scenario, not just failures). `--kickoff TEXT` has no effect on `live-verify-opening-phrase.mjs`, which never sends a kickoff.

`live-verify-connect-timing.mjs` adds `--runs N`, `--mic immediate|deferred|denied`, `--mode avatar|agent-avatar`, `--opening TEXT`, `--no-kickoff`, `--budget-<kpi> MS`, `--no-budgets`, and `--hints off|on|ab`. `--hints ab` alternates runs between the plain page and the same page with `<link rel=preconnect|dns-prefetch|preload|modulepreload>` tags injected, then prints the per-arm medians and the delta. The full flag list with every KPI budget is in that script's header.

```bash
node scripts/live-verify-connect-timing.mjs --runs 5
node scripts/live-verify-connect-timing.mjs --runs 10 --hints ab
node scripts/live-verify-kickoff.mjs --env eu --env-file ../.env --only V4,V6
node scripts/live-verify-kickoff.mjs --browser chrome --headed --keep
node scripts/live-verify-opening-phrase.mjs --env eu:2 --env-file ../.env --only P1,P2
```

### The throwaway agent

The browser-driving live scripts provision their own agent, use it, and delete it. The lifecycle is:

1. Provision an intellect, an avatar, and an agent, with `openingPhrase: SILENT_OPENING`.
2. Run the scenarios against it.
3. Delete agent → avatar → intellect, unless `--keep`.

A provisioning failure part-way through still deletes whatever was created before the error. `--agent-json PATH` skips both provisioning and deletion, which is what you want while iterating on one scenario: run once with `--keep`, save the printed ids to a file, then reuse it.

Nothing in that flow is committed. Ids live in your `--agent-json` file and in the run artifact, both outside git.

### Artifacts

Every live run writes `<runId>.json` and `<runId>.md` to `--out` (default `live-verify-artifacts/`, gitignored). The markdown is a table you can read directly; the JSON holds every event, stat, and timing. Session tokens and URL query strings are redacted before anything is written.

CI uploads these as job artifacts. Timing numbers from them can inform a budget in a tracked script. Nothing else from an artifact belongs in a tracked file.

### Retries in CI

The live jobs share a production backend, so an outside blip can fail a step the SDK did nothing wrong in. Two scripts keep that from failing a PR:

| Script | What it does |
|---|---|
| `live-verify-preflight.mjs` | Runs before the live steps. Waits up to 4 minutes for every backend service to answer below 500. If one stays down, the job fails with one "backend unavailable" error and the live steps are skipped. Read-only, no credentials. `--wait 0` probes once |
| `live-step.mjs` | Runs each live step: `node scripts/live-step.mjs --log FILE -- CMD...`. Tees the output to `FILE`. On a failure it waits 20 s and for the backend, then runs the step once more. It retries only when a second try as long as the first still fits 14 minutes, so both tries fit the 15-minute step timeout. It never retries after a cancel. `LIVE_STEP_RETRIES=0` turns retries off |

A real regression fails both tries. A step that passes only on its retry shows a "passed on retry" warning and a line in the job summary, and its log keeps both tries. Treat a step that keeps passing on retry as a flaky test to fix. A manual run of `live-verify.yml` with `retry` off shows every first-try failure.

A retried script must be safe to run twice in a row: unique names per run, cleanup in `finally`, and no checks on counts or state the first try leaves behind. The logic and the backend probes live in `lib/live-step.mjs` and `lib/backend-health.mjs`.

## Gate runners

Three entry points are easy to confuse. They do different things.

| Command | What it is |
|---|---|
| `npm run verify` (`agent_verify.mjs`) | The Constitution verifier. One check per rule id in [SDK_CONSTITUTION.md](../SDK_CONSTITUTION.md), then the full test suite. Exits 0 when every rule and every test passes |
| `npm run harness` (`harness/run.mjs`) | Runs three gates in order: `npm run verify` (Constitution rules and the test suite), a semgrep SAST pass, `npm run docs:gate`. Reuses the existing gates rather than duplicating them |
| `npm run harness:constitution` (`tools/constitution-harness.mjs`) | Supplements `agent_verify.mjs` with the few checks a rule-presence scan cannot express: numeric thresholds, an accumulation guard, the fetch-injectability contract, and closure checks on named symbols |

## What CI runs

| Workflow | Jobs |
|---|---|
| `ci.yml` | Offline tests with coverage, the 3-engine `avatar-media` matrix, the 3-engine `noise-suppressor` matrix, the Constitution verifier, lint/typecheck/circular, the docs gate, semgrep, workflow lint (actionlint) |
| `live-verify.yml` | One job per CI-run live script. Runs on manual dispatch, on every PR from a branch in this repo (only jobs whose paths changed), and in the merge queue (same path filter). Fork and Dependabot PRs get no secrets, so no live job runs there: a fork PR that touches live paths fails the `Live verification` check until a maintainer opens a replacement PR from a branch in this repo, and a Dependabot PR passes with a notice. A nightly schedule (03:00 UTC) runs every job and is the startup-KPI trend run |
| `release.yml` | On a `v*.*.*` tag. Job `release`: release notes file check, docs manifest coverage, jsDelivr smoke test, npm install route test, create the GitHub Release, fire `generate-docs`. Job `distribution`: `npm run verify:distribution -- <tag>`, which checks the published jsDelivr tree matches the tag |

Ten live scripts have no CI job (named under the script table). Run them by hand when you touch their surface.

## Extending

**A new media scenario.** Add a cell to `../test/browser/avatar-media.html` and its name to `EXPECTED_CELLS` in `verify-avatar-media.mjs`. See [test/browser/README.md](../test/browser/README.md).

**A new kickoff scenario.** Add an entry to `SCENARIOS` in `live-verify-kickoff.mjs`. Each entry has a `name` and a function that drives the page and returns checks. Add the id to the table in the file header, then add a row to the `--only` docs above if the id scheme changes.

**A new timing probe.** Record it in `live-verify-kickoff.html` (the page owns the measurement), read it in `live-verify-connect-timing.mjs`, and add it to the KPI budget list in that script's header. A probe with no budget is a number nobody reads.

**A new live script.** Copy the closest existing one. Keep the header comment stating what it asserts, delete everything it creates, add an `npm run live-verify:<name>` script, and add a step to `live-verify.yml` that runs it through `live-step.mjs`. If it needs a browser, reuse `live-verify-kickoff-shared.mjs`: `bootstrap()` for CLI and env parsing, `ensureAgent()` for the throwaway agent, `startServer()`/`launchBrowser()`/`openHarness()` for the page, `Report` for the artifact. If it asserts on what the agent says back, also pass `writeSilentWav()` from `live-verify-silent-mic-shared.mjs` to `--use-file-for-fake-audio-capture`.

Whatever you add, assert only what a caller can observe: session events, socket frames, HTTP status codes, documented error codes, response shapes, WebRTC stats. Never assert on server internals, and never write an id, a token, or a partner id into a tracked file.

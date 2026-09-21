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

Plain `node:test`, no browser, no network. Layers live under `test/unit`, `test/integration`, `test/e2e`, `test/evals`. See [README.md → Testing](../README.md#testing) for what each layer covers.

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

Both scripts write a JSON result to `.harness-output/` (gitignored, regenerated every run).

Adding or renaming a scenario in `avatar-media.html` means updating `EXPECTED_CELLS` in `verify-avatar-media.mjs` too, and an engine that cannot run a check has to be listed in `ALLOWED_SKIPS`. [test/browser/README.md](../test/browser/README.md) is the guide for that page.

## Tier 3: live backend

Every `live-verify-*.mjs` script talks to a real deployment with real credentials. They provision throwaway objects, assert what a caller observes, and clean up after themselves.

### Credentials

Drop a `.env` in the repo root (or export the vars). Nothing here reads a committed file, and no script ever writes a credential to an artifact.

Most scripts read two vars and use the SDK's default URLs:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your-admin-secret
```

The scripts built on `live-verify-kickoff-shared.mjs` (`live-verify-kickoff.mjs`, `live-verify-connect-timing.mjs`, `live-verify-opening-phrase.mjs`) also accept `--env` to pick the environment or region they run against:

| `--env` | Credentials | URLs |
|---|---|---|
| `prod` (default) | `AGENTIC_PARTNER_ID`, `AGENTIC_ADMIN_SECRET` | SDK defaults |
| `<name>` or `<name>:<account>` | `<NAME>_PARTNER_ID_<account>`, `<NAME>_ADMIN_SECRET_<account>` (account defaults to `1`), or `<NAME>_PARTNER_ID`, `<NAME>_ADMIN_SECRET`, or `<NAME>_AGENTIC_PARTNER_ID`, `<NAME>_AGENTIC_ADMIN_SECRET` | `<NAME>_AGENTIC_API_URL`, `<NAME>_GENIE_URL`, `<NAME>_KALTURA_API_ENDPOINT` |

`<name>` is lowercase letters and digits; `<NAME>` is the same text in upper case. Every URL is passed to `Management` explicitly, so a named environment never falls back to the production defaults. Example: `--env eu` reads `EU_PARTNER_ID_1`, `EU_ADMIN_SECRET_1`, `EU_AGENTIC_API_URL`, `EU_GENIE_URL`, `EU_KALTURA_API_ENDPOINT`; `--env eu:2` swaps in the `_2` credential pair. A missing var exits 1 before any network call. Get a partner id and admin secret from Kaltura Rich Media CMS → Settings → Integration Settings.

### Which script to run

| Script | Covers |
|---|---|
| `live-verify.mjs` | Smoke test: admin token → intellect → conversation token → one turn → delete |
| `live-verify-kickoff.mjs` | Every silent-opening + `kickoff` scenario, one fresh browser context each |
| `live-verify-connect-timing.mjs` | Startup KPIs: time to `connect()`, first video frame, first audio, first agent words |
| `live-verify-opening-phrase.mjs` | `provision()` writes the opening phrase to the intellect only, a Jinja2 `{% if %}` phrase renders per session from `requestVars`, and `SILENT_OPENING` on the intellect alone gives a silent opening turn |
| `live-verify-browser.mjs` | Browser smoke test: real WHEP downlink, real WebRTC, real media element |
| `live-verify-avatar-media.mjs` | The merged-stream media path against a real downlink |
| `live-verify-session-complete.mjs` | The `session_completed` signal and its presence mechanism |
| `live-verify-context-fields.mjs` | `contextId`/`contextType` actually reach the prompt at runtime |
| `live-verify-request-vars.mjs` | Every documented `request_vars` behavior over `converseOnce` |
| `live-verify-site-nav.mjs` | The `go_to` contract end to end |
| `live-verify-set-forced-language.mjs`, `live-verify-force-language.mjs` | A forced language changes the reply, not just storage |
| `live-verify-capabilities.mjs` | Capability resolution plus the Lifecycle domain |
| `live-verify-agents.mjs`, `live-verify-avatars.mjs`, `live-verify-catalog.mjs`, `live-verify-tools.mjs`, `live-verify-skills.mjs`, `live-verify-knowledge.mjs`, `live-verify-intellects-conversations.mjs`, `live-verify-threads-messages-feedback.mjs`, `live-verify-conversation-avatar-surface.mjs` | The write path of one management resource each |

Every one of these has an `npm run live-verify:<name>` script except `live-verify.mjs`. Four have no npm script and no CI job. Run them with `node scripts/<name>.mjs`: `live-verify-intellect-config.mjs`, `live-verify-knowledge-kms.mjs`, `live-verify-feedback-flow.mjs`, `live-check-feedback-unfiltered.mjs`. One more has an npm script but no CI job either: `live-verify-force-language.mjs`, run by hand with `npm run live-verify:force-language`.

Read the header comment of a script before running it. Each one states what it asserts and why that coverage exists.

Three helper modules are not scripts and are never run directly: `live-verify-kickoff-shared.mjs` (CLI/env parsing, throwaway agent, server, browser, report), `live-verify-silent-mic-shared.mjs` (a silent WAV for `--use-file-for-fake-audio-capture`, so the fake mic's tone is not transcribed as invented user speech), and `live-verify-hooks-shared.mjs` (a bounded timeout around the page-side `window.test*` hooks, so a hook that never settles fails with a diagnostic instead of hanging the job).

### Flags

Only `live-verify-kickoff.mjs`, `live-verify-connect-timing.mjs` and `live-verify-opening-phrase.mjs` take CLI flags (they share `live-verify-kickoff-shared.mjs`). Every other script is configured by env vars alone.

Shared by all three:

| Flag | Effect |
|---|---|
| `--env prod\|<name>[:<account>]` | Environment or region to run against. Default `prod`. See the table above |
| `--env-file PATH` | Read env vars from `PATH` instead of `./.env` |
| `--browser chromium\|chrome\|firefox\|webkit` | Engine. `chrome` is the installed Google Chrome, always headed, audio audible |
| `--headed` | Show the browser window |
| `--kickoff TEXT` | Override the kickoff text |
| `--out DIR` | Artifact directory. Default `live-verify-artifacts/` |
| `--keep` | Do not delete the throwaway agent at the end |
| `--agent-json PATH` | Reuse the agent described in `PATH` instead of provisioning one. Deletes nothing |

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

## Gate runners

Three entry points are easy to confuse. They do different things.

| Command | What it is |
|---|---|
| `npm run verify` (`agent_verify.mjs`) | The Constitution verifier. One check per rule id in [SDK_CONSTITUTION.md](../SDK_CONSTITUTION.md). Exits 0 when every rule passes |
| `npm run harness` (`harness/run.mjs`) | Runs three gates in order: `npm run verify`, a semgrep SAST pass, `npm run docs:gate`. Reuses the existing gates rather than duplicating them |
| `npm run harness:constitution` (`tools/constitution-harness.mjs`) | Supplements `agent_verify.mjs` with the few checks a rule-presence scan cannot express: numeric thresholds, an accumulation guard, the fetch-injectability contract, and closure checks on named symbols |

## What CI runs

| Workflow | Jobs |
|---|---|
| `ci.yml` | Offline tests with coverage, the 3-engine `avatar-media` matrix, the 3-engine `noise-suppressor` matrix, the Constitution verifier, lint/typecheck/circular, the docs gate, semgrep |
| `live-verify.yml` | One job per live script. Runs on manual dispatch, on a PR labeled `run-live-verify`, and in the merge queue. Only `live-verify-kickoff` also runs on a weekly schedule |
| `release.yml` | `npm run verify:distribution -- <tag>`, which checks the published jsDelivr tree matches the tag |

The four local-only scripts, plus `live-verify-force-language.mjs`, have no CI job. Run them by hand when you touch their surface.

## Extending

**A new media scenario.** Add a cell to `../test/browser/avatar-media.html` and its name to `EXPECTED_CELLS` in `verify-avatar-media.mjs`. See [test/browser/README.md](../test/browser/README.md).

**A new kickoff scenario.** Add an entry to `SCENARIOS` in `live-verify-kickoff.mjs`. Each entry has a `name` and a function that drives the page and returns checks. Add the id to the table in the file header, then add a row to the `--only` docs above if the id scheme changes.

**A new timing probe.** Record it in `live-verify-kickoff.html` (the page owns the measurement), read it in `live-verify-connect-timing.mjs`, and add it to the KPI budget list in that script's header. A probe with no budget is a number nobody reads.

**A new live script.** Copy the closest existing one. Keep the header comment stating what it asserts, delete everything it creates, add an `npm run live-verify:<name>` script, and add a job to `live-verify.yml`. If it needs a browser, reuse `live-verify-kickoff-shared.mjs`: `bootstrap()` for CLI and env parsing, `ensureAgent()` for the throwaway agent, `startServer()`/`launchBrowser()`/`openHarness()` for the page, `Report` for the artifact. If it asserts on what the agent says back, also pass `writeSilentWav()` from `live-verify-silent-mic-shared.mjs` to `--use-file-for-fake-audio-capture`.

Whatever you add, assert only what a caller can observe: session events, socket frames, HTTP status codes, documented error codes, response shapes, WebRTC stats. Never assert on server internals, and never write an id, a token, or a partner id into a tracked file.

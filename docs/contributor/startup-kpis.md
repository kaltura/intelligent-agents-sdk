> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Startup KPIs

How the SDK tracks avatar startup speed, and which checks guard the opening-phrase path. App-facing behavior is in [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

## Typical timings

Event order for an avatar session with `SILENT_OPENING` and a `kickoff`, from live headless-browser runs with a fake mic:

| Step | Event | Typical time |
|---|---|---|
| 1 | `connect()` starts | 0 |
| 2 | `connect()` resolves | 1.5 to 2.2 s |
| 3 | Silent opening turn ends (`avatarStopTalking`) | about 0.3 s after step 2 |
| 4 | The SDK sends the kickoff | same tick as step 3 |
| 5 | `responsePending` fires | tens of ms after step 4 |
| 6 | First real words (`speechChunk`) | about 1 s after step 2 |

With a scripted opening, the first `speechChunk` arrives about 0.2 s after step 2.

## The KPI check

`scripts/live-verify-connect-timing.mjs` checks the median of each startup KPI against a fixed budget and fails when one is missed:

- `connect()` resolved
- First video frame
- First audio
- First words after `connect()` resolved
- Sound heard

`--compare jinja` runs three openings side by side: silent + kickoff, a scripted opening and the preset-question pattern. Each has its own budgets. The script header lists the budgets and how they were calibrated.

| Command | What it does |
|---|---|
| `npm run live-verify:connect-timing` | Measures the silent + kickoff path. `--browser` picks the engine and `--headed` shows the run |
| `npm run live-verify:connect-timing:compare` | Compares the three openings. Add `-- --prompt-kb N` to pad each prompt with N KB of neutral text |

## CI

The job runs on pull requests that touch its paths, in the merge queue, on manual dispatch and on a nightly schedule. Fork and Dependabot pull requests get no secrets, so the job does not run for them. See the header of `.github/workflows/live-verify.yml`.

## Opening-phrase checks

| Check | Covers |
|---|---|
| `scripts/live-verify-opening-phrase.mjs` | Live. Provisions a throwaway agent, sets `{% if %}` templates, and asserts the spoken opening with and without `requestVars`, the preset-question branch and a re-join of the same thread |
| `test/integration/intellect-config.test.js`, `test/integration/avatars-catalog.test.js` | The same calls without a live backend |

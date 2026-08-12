# Contributing

This repo is private (Kaltura-internal) for now. The workflow below applies to
internal contributors with push access, cloning directly.

> **Not yet applicable — TODO.** Once the repo opens up to external contributors, this
> section will describe a fork-based workflow (fork on GitHub, clone your fork, open a
> PR from a branch on your fork back to this repo). That workflow doesn't exist yet —
> there is no external-contributor path today.

See [README.md](README.md)'s note on issue references.

## Before you start

New to the SDK itself? Read [GETTING-STARTED.md](GETTING-STARTED.md) first to see it
run end to end (including a zero-credential offline demo) before diving into the
contribution workflow below.

Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — it applies to every interaction in
this repo (issues, PRs, reviews).

Read [SDK_CONSTITUTION.md](SDK_CONSTITUTION.md) next — it's the rulebook this
SDK is held to, and every rule in it is machine-checked. A change that reads
correctly but breaks a rule (e.g. adds a runtime dependency, adds a module-level
`let`, or introduces dead code with no consumer) fails CI before a human ever
reviews it.

## Setup

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk
npm test
```

No `npm install` step — the SDK is zero-dependency and the test runner is
`node:test` (Node.js ≥18 built-in). If `npm test` doesn't pass on a clean
checkout before you change anything, stop and report it rather than building
on top of a broken baseline.

## Making a change

1. Add or update tests under `test/unit`, `test/integration`, `test/e2e`, or
   `test/evals` — whichever matches the surface you're touching. See
   [README.md → Testing](README.md#testing) for what each layer covers.
2. Run the full local gate before opening a PR:

   ```bash
   npm test          # all test layers
   npm run verify     # SDK_CONSTITUTION.md rules (scripts/agent_verify.mjs)
   npm run docs:gate  # docs/code drift, secrets, GFM hygiene (tools/check-docs.mjs)
   ```

3. If you touched a documented behavior (an endpoint, a payload shape, a wire
   event, a capability), update the doc in the **same change** — `docs:gate`
   fails the build on drift, and reviewers should not need to chase it down.
4. Keep the change scoped. This SDK favors small, reviewable diffs over broad
   refactors; see [SDK_CONSTITUTION.md](SDK_CONSTITUTION.md) for the specific
   engineering rules (no module-level mutable state, no dynamic `eval`, zero
   runtime deps, JSDoc on every exported symbol, etc.).

## Opening a PR

- Describe *why*, not just *what* — the diff already shows what changed.
- Confirm in the PR description that `npm test`, `npm run verify`, and
  `npm run docs:gate` all pass locally; CI re-runs all three and blocks merge
  on any failure.
- If the change affects the public API surface (`exports` in `package.json`),
  add a `CHANGELOG.md` entry.

## Commit and branch conventions

Commit messages in this repo's history (`git log --oneline`) are a short, capitalized,
imperative summary line — e.g. "Add release automation and CI test reporting", "Redact
internal service/repo names from public docs", "Fix CI: revert Node 18/20/24 test
matrix". Follow that style: lead with a verb, describe the *what* in one line, and use
a `Prefix: detail` form (like the `Fix CI:` example) when a commit is scoped to one
area. There is no branch-naming convention enforced today — this repo has had only one
active branch (`main`) throughout its history so far.

## CLA / licensing (external contributors)

Licensing terms for external (non-Kaltura) contributions are **TBD** — there is no CLA
process in place yet. This section will be filled in before the repo opens up to
outside contributors; don't assume any specific CLA terms until then.

## Reporting a security issue

Do not open a public issue for a security vulnerability. See
[SECURITY.md](SECURITY.md) for the disclosure process.

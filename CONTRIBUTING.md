> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](docs/contributor/README.md).

# Contributing

Kaltura maintainers push directly. Everyone else uses the standard GitHub fork workflow: fork this repo, push a branch to your fork, then open a PR from that branch to `main` in `kaltura/intelligent-agents-sdk`.

## Before you start

Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). It applies to every issue, PR and review.

Read [SDK_CONSTITUTION.md](SDK_CONSTITUTION.md) next. Every rule in it is machine-checked, so a change that breaks one fails CI before a human reviews it.

## Setup

```bash
git clone https://github.com/kaltura/intelligent-agents-sdk.git
cd intelligent-agents-sdk
npm ci
npm test
```

The SDK has zero runtime dependencies. `npm ci` installs the dev tools only (jsdom and axe-core for the a11y tests, eslint, madge, typescript, playwright). The test runner is `node:test` (Node.js 18 or later). If `npm test` fails on a clean checkout, stop and report it.

## Making a change

1. Add or update tests under `test/unit`, `test/integration`, `test/e2e`, or `test/evals`, whichever matches the surface you change.
2. Node tests cannot reach every surface. Media, WebRTC and autoplay behavior needs the real-browser harness, and the management and runtime wire contracts need a live backend. [scripts/README.md](scripts/README.md) explains the three verification tiers, which one matches your change, and how to extend each. [test/browser/README.md](test/browser/README.md) covers the media harness page.
3. Run every gate in the [Commands table in AGENTS.md](AGENTS.md#commands) before you open a PR.
4. If you touched a documented behavior (an endpoint, a payload shape, a wire event, a capability), update the doc in the **same change**. `npm run docs:gate` fails the build on drift.
5. Keep the change scoped. Small, reviewable diffs beat broad refactors.
6. Keep backend detail out of code, docs, tests, commit messages and the PR. See "Public boundary" in [AGENTS.md](AGENTS.md#public-boundary).

## Opening a PR

- Describe *why*. The diff already shows what changed.
- Confirm that the gates in [AGENTS.md](AGENTS.md#commands) pass locally. CI re-runs them and blocks merge on any failure.

## Commit and branch conventions

This repo's history (`git log --oneline`) mixes two styles: a short, capitalized, imperative summary line (e.g. "Add release automation and CI test reporting") and Conventional Commits prefixes (e.g. `feat(management): describe the customer-admin intellect surface exactly`). Either is fine. Lead with a verb, describe the *what* in one line, and add a `type(scope):` or `Prefix:` tag when a commit is scoped to one area. Branch names follow the same informal `type/short-description` pattern (e.g. `feat/`, `fix/`, `chore/`, `docs/`), but nothing enforces it.

## Licensing (external contributors)

This repo is [MIT licensed](LICENSE). By opening a PR, you agree your contribution is licensed under that same MIT license. No separate CLA is required.

## Reporting a security issue

Do not open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md) for the disclosure process.

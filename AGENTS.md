> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](docs/contributor/README.md).

# AGENTS.md

Guide for people and coding agents working on the SDK itself. To build an app with the SDK, use the plugin in [app-builder-skill/README.md](app-builder-skill/README.md).

## What this repo is

`@kaltura/intelligent-agents`: raw ESM, zero runtime dependencies, no build step, private package. Consumers import `src/` directly or load it from jsDelivr pinned to a git tag. The entry points are the `exports` map in `package.json`.

## Commands

| Command | Use |
|---|---|
| `npm test` | Full test suite |
| `npm run test:ci` | Same suite with the coverage gates CI enforces |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc` over the JSDoc types |
| `npm run verify` | Constitution rule checks, then the test suite (`scripts/agent_verify.mjs`) |
| `npm run harness:constitution` | Constitution checks that a rule scan cannot express |
| `npm run circular` | Circular-import check over `src/` |
| `npm run docs:gate` | Docs drift, secrets and GFM checks (`tools/check-docs.mjs`) |

Run all of them before a PR.

## Rules that fail CI most often

Full list: [SDK_CONSTITUTION.md](SDK_CONSTITUTION.md).

| Rule | Meaning |
|---|---|
| I-1 | No module-level mutable state |
| D-1 | JSDoc on every public export |
| D-3 | No TODO, FIXME or HACK in `src/` |
| P-3 | Zero runtime dependencies |
| S-5 | Admin secret is non-enumerable |

## Docs

Read [docs/contributor/DOCS-GUIDE.md](docs/contributor/DOCS-GUIDE.md) before you edit any `.md` file. It defines the user and contributor doc tiers, the content and length rules, and what `tools/check-docs.mjs` enforces. Update docs in the same PR as the behavior change.

## Public boundary

Nothing internal goes into any tracked file, commit message, issue or PR: no backend repo names, no internal field or class names, no unpatched bugs, no partner ids or tokens. Describe only what a caller of the SDK observes.

## Deprecating a public symbol

Add a `@deprecated` JSDoc tag in the same PR that announces the deprecation. The skill check in `tools/check-docs.mjs` then fails if the app-builder skill mentions the symbol. Remove the symbol, its docs and its examples in the next major version.

## The app-builder skill

`app-builder-skill/` is a Claude Code plugin. It holds the order of steps and pointers to the official docs, never API facts or code. The agent reads the docs site and the installed package live, so most SDK changes need no skill edit.

Keep `node tools/check-docs.mjs` green. Block 15 checks that every method, import, example and URL the skill names still exists, and that nothing deprecated appears. A nightly workflow (`skill-links.yml`) checks that the skill's site pages still load.

Before each release, run the skill evals locally with your own Claude login:

```bash
claude plugin validate ./app-builder-skill
claude plugin eval ./app-builder-skill --allow-tools "WebFetch(domain:kaltura.github.io)" "Bash(node -v)" "Bash(git --version)" Write Edit
```

Cases are in `app-builder-skill/evals/`. Add `--runs 1 --ablation none` for a quick pass. The eval sandbox blocks network access, so cases that need the docs (`chat-widget`, `csv-tool`, `deck-presenter`, `train-on-sdk`) can stop at Rule 0 and score low. For those, read the trace: a stop that names the block and still applies the Hard rules is correct. The real check is an install test: run `claude -p "..." --plugin-dir ./app-builder-skill` in an empty folder with network on, then confirm the code's imports resolve. When the Claude Code major version changes, re-read the plugin and agentskills.io docs and confirm `claude plugin validate` still passes. Bump the pinned `@anthropic-ai/claude-code` version in `ci.yml` at the same time.

## Release order

1. Merge the SDK PR.
2. Add any new manifest entries or ignores on `gh-pages-src`.
3. Tag. The release workflow checks the release notes file, docs coverage, jsDelivr and the npm install route.
4. Merge the docs site sync PR.
5. Bump the SDK pin in Nova (`docs-site-avatar`).

## Release notes

Write them by hand in the version bump PR, as `.github/release-notes/vX.Y.Z.md`. The release workflow publishes that file and fails without it. Do not use auto-generated notes.

| Part | Rule |
|---|---|
| Heading | `## vX.Y.Z` on the first line |
| Summary | One or two sentences. Say if anything can break existing code |
| Sections | `### Added`, `### Changed`, `### Fixed`, `### Behavior change`, `### Docs and skill`. Keep only the ones that apply |
| Bullets | One line each, what a caller sees, PR number last |
| Tables | Only for before/after comparisons |
| Last line | `**Full Changelog**` compare link |
| Never | Internal repo names, backend detail, unpatched bugs, merge-commit titles pasted as bullets |

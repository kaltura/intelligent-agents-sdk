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
| `npm run verify` | Agent verification script |
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

- Update docs in the same PR as the behavior change.
- Each fact lives in one place. Link to it, do not copy it.
- Docs describe the current state and what is planned. No history blocks, no "formerly" notes.
- Write plain English at B2 level. No hard wraps inside a paragraph.
- A new root `*.md` or `docs/**` page needs a site manifest entry on `gh-pages-src` before the next tag, or the release check fails.

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
claude plugin eval ./app-builder-skill --allow-tools "WebFetch(domain:kaltura.github.io)" "Bash(node -v)" "Bash(git --version)"
```

Cases are in `app-builder-skill/evals/`. Add `--runs 1 --ablation none` for a quick pass. When the Claude Code major version changes, re-read the plugin and agentskills.io docs and confirm `claude plugin validate` still passes. Bump the pinned `@anthropic-ai/claude-code` version in `ci.yml` at the same time.

## Release order

1. Merge the SDK PR.
2. Add any new manifest entries or ignores on `gh-pages-src`.
3. Tag. The release workflow checks docs coverage, jsDelivr and the npm install route.
4. Merge the docs site sync PR.
5. Bump the SDK pin in Nova (`docs-site-avatar`).

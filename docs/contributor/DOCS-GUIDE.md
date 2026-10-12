> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Docs Guide

Rules for every `.md` file in this repo. `node tools/check-docs.mjs` enforces the ones marked **checked**.

## Two tiers

| Tier | Where | Reader | Published |
|---|---|---|---|
| User docs | `README.md`, `API-REFERENCE.md`, `GETTING-STARTED.md`, `SECURITY.md`, `docs/**` except `docs/contributor/` | Developers and coding agents building an app with the SDK | Docs site and the docs assistant |
| Contributor docs | `docs/contributor/**`, `AGENTS.md`, `CONTRIBUTING.md`, `SDK_CONSTITUTION.md`, `CODE_OF_CONDUCT.md`, `scripts/README.md` | People changing the SDK | This repository only. Public, not on the docs site |

- Every file in `docs/contributor/` starts with the contributor banner (see [README.md](README.md)). **Checked.**
- User docs never link to contributor docs. **Checked.**
- A fact a contributor needs but an app builder does not goes in a contributor doc. If a caller can observe it, it goes in a user doc.
- A new user doc needs a site manifest entry on `gh-pages-src` before the next tag. Contributor docs need none.

Contributor docs are public like every other file here. "Contributor" means the reader, not secrecy. No doc, in either tier, holds Kaltura-internal or backend detail (see Public boundary below).

## Content rules

| Rule | Meaning |
|---|---|
| One home per fact | State it once and link to it. A copy drifts. |
| Current state only | No history, status blocks, "formerly" or "no longer" notes. **Checked.** |
| Authoritative voice | Say what the SDK does. No "may want to", "consider", "usually", "probably", "you could". **Checked** outside code fences. |
| Public API only | User docs name no private symbol (a name that starts with `_`, except `_meta`). **Checked.** |
| Public boundary | No backend repo names, internal class or field names, unpatched bugs, partner ids or tokens. See [AGENTS.md](../../AGENTS.md). |
| Plain English | B2 level, short sentences, no em dashes, no hard wraps inside a paragraph. |
| Guide, do not survey | Give one recommended path. Mention an alternative only when the reader must choose. |

## Structure and length

Readers are impatient, and coding agents have limited context. Each page must let them stop reading early.

1. Line 1 after the title: what the page covers and who needs it, in one or two sentences.
2. Next: the answer, a table or a short list. Detail comes after.
3. Headings state the task or the question ("Retry a failed connect"), not the topic.
4. Prefer tables for reference data and numbered lists for steps.
5. Keep a page under 250 lines. **Checked** with a ratchet: pages already over the limit cannot grow. Split a page before it passes the limit.
6. A long page that must stay long opens with a purpose statement and a table of what it covers.

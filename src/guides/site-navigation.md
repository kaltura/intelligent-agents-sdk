---
layout: base.njk
title: "Site Navigation with go_to"
description: "How to let a Kaltura avatar move the visitor to the right page and section of your website while it answers: one fire-and-forget go_to client tool, a build-time sections manifest, and the SiteNavigator browser plugin."
eyebrow: How-to Guide
---

# Site navigation — one fire-and-forget `go_to` tool for any website

Let the agent move the visitor to the right page and section of your site while it answers. One client tool, two string arguments, no result to wait for, so it can never spiral or leave the avatar silent.

**On this page:** [Why fire-and-forget](#why-fire-and-forget) · [The manifest (`sections.json`)](#the-manifest-sectionsjson) · [Provisioning](#provisioning) · [Browser plugin](#browser-plugin) · [Adapters](#adapters) · [Taking it to another app](#taking-it-to-another-app) · [Testing](#testing) · [Security](#security) · [Related docs](#related-docs)

```text
brain:    go_to({ path: "/guides/pause-resume/", section: "edge-case-dont" })
browser:  navigate("/guides/pause-resume/#the-edge-case-dont-leave-the-avatar-stuck-paused") → scroll → point
brain:    "Pause before the video starts and resume on its ended event..."
```

Three pieces, one shared contract:

| Piece | Entry point | Runs where |
|---|---|---|
| Manifest builder + resolvers | `./management` (also `src/core/site-keys.js`) | your site build, Node |
| `goToTool()`, `siteMapPrompt()`, `SITE_NAV_RULES_PROMPT`, `loadSectionsManifest()` | `./management` | provisioning script, Node |
| `SiteNavigator` | `./experience/site-nav` | browser, next to the session |

## Why fire-and-forget

A navigation tool needs no answer from the page. The tool is provisioned with `wait_for_response: false`, so the backend produces the tool result itself right after the model emits the call and the browser never sends anything back. There is nothing to ACK, time out on, or retry. The model writes its spoken answer in the same turn. Compare [Client-Side Commands § Tool spirals](/guides/client-commands/#tool-spirals-starve-the-voice--budget-tools-per-turn) for what happens to tools that do wait.

Two consequences shape the browser side:

- The model may emit two `go_to` calls in one turn when a question spans two pages. The plugin executes the first call that resolves to a real page and drops the rest until the next turn (`oncePerTurn`).
- The model may send a slightly wrong path or section. The plugin resolves both against the manifest with a fallback chain, and an unknown section still lands on the page top. An unknown path is dropped, never guessed.

## The manifest (`sections.json`)

The site build publishes one public JSON file. The same file feeds the prompt (rendered as a SITE MAP) and the browser (resolution).

```json
{
  "version": 1,
  "lang": "en",
  "generatedAt": "2026-09-04T10:00:00.000Z",
  "pages": [
    {
      "path": "/guides/pause-resume/",
      "title": "Pause/Resume for Video",
      "sections": [
        { "key": "what-it-is", "id": "what-it-is", "text": "What it is" },
        { "key": "edge-case-dont", "id": "the-edge-case-dont-leave-the-avatar-stuck-paused", "text": "The edge case: don't leave the avatar stuck paused" },
        { "key": "demo-box", "id": "demo-box", "text": "Live demo", "kind": "target" }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Format version, always `1` today. `validateSectionsManifest` rejects anything else. |
| `lang` | Language code used for the stop-word list. |
| `pages[].path` | Site-relative path with leading slash, prefix-free (`/guides/x/`, not `/docs/guides/x/`). Sorted. |
| `pages[].title` | Optional, for humans and tooling. Not sent to the model. |
| `sections[].key` | Compact key the model uses (2–3 content words). Unique per page. |
| `sections[].id` | Real DOM id of the element to scroll to. |
| `sections[].text` | Heading text, used by the fuzzy resolver. |
| `sections[].kind` | `heading` (default) or `target` for hand-placed anchors. Future kinds resolve through the same chain. |

Only public data belongs here: paths and headings that are already on the page. Never add internal notes, draft pages, or anything a visitor should not see.

### Building it

`buildSectionsManifest(pages, opts)` takes any page source: built HTML, a markdown tree, a SPA route table, a CMS export. Only `path` is mandatory per page.

```js
import { buildSectionsManifest } from '@kaltura/intelligent-agents/management';

const manifest = buildSectionsManifest([
  { path: '/guides/pause-resume/', title: 'Pause/Resume', headings: [
    { id: 'what-it-is', text: 'What it is', level: 2 },
    { id: 'the-edge-case-dont-leave-the-avatar-stuck-paused', text: "The edge case: don't leave the avatar stuck paused", level: 2 },
  ], targets: [{ id: 'demo-box', text: 'Live demo' }] },
], { lang: 'en', depth: 2 });
writeFileSync('_site/nova/sections.json', JSON.stringify(manifest));
```

| Option | Default | Effect |
|---|---|---|
| `lang` | `'en'` | Picks the stop-word list. Only `en` ships. |
| `stopWords` | | `{ fr: ['le', 'de', 'la'] }` adds or replaces a list for a language. |
| `depth` | `2` | Keep headings with `level <= depth`. Headings without a `level` are always kept. `3` adds h3 keys and about 50% more tokens. |
| `maxWords` | `3` | Preferred key length in words. |
| `overrides` | | `{ 'heading-id-or-text': 'better-key' }` hand-fixes a weak key without touching the algorithm. |
| `generatedAt` | now | Pin it for reproducible builds and tests. |

### How keys are derived

Deterministic, so a docs change re-keys only the page it touched:

1. NFKC-normalize the heading, drop URLs, drop apostrophes and dots inside words (`don't` → `dont`, `v2.3` → `v23`), split on anything that is not a letter or number. Hebrew, CJK, accented Latin and emoji-laden headings all yield usable keys.
2. Lower-case and drop stop words. A single upper-case letter like the `A` in `Recipe A` survives. Pure numbers drop when at least two other words remain.
3. Take the first `maxWords` words, hyphen-joined. Fewer than two words left means the full word list is used; nothing left means `section`.
4. On a collision within the page, extend the key one word at a time, then suffix `-2`, `-3`.
5. Boilerplate headings (`Related docs`, `Contents`, `On this page`, `Next steps` and friends, see `BOILERPLATE_IDS`) are left out so the model never targets them.

`pageSectionKeys(headings, opts)` exposes step 1–5 for one page when you need only the keys.

### Rendering the SITE MAP

`renderSiteMap(manifest)` gives the prompt text: two lines per page, the page title and then `path: key1, key2`, with a blank line between pages. About 45 tokens per page. The title lets the model match what a visitor calls a page ("the wire protocol page") to its path. The path line carries only the path and the keys: a label next to the path gets copied into `go_to` as part of the path. `siteMapPrompt(manifest)` wraps it as a prompt block and warns (never throws) when the estimate passes `maxTokens` (default 3000). The docs site's 49 pages and 202 sections render to roughly 2300 tokens.

## Provisioning

```js
import {
  Management, goToTool, siteMapPrompt, SITE_NAV_RULES_PROMPT, PAGE_CONTEXT_PROMPT, loadSectionsManifest,
} from '@kaltura/intelligent-agents/management';

const m = new Management({ partnerId, adminSecret });
const ks = await m.sessions.createAdminToken();
const manifest = await loadSectionsManifest('https://docs.example.com/nova/sections.json');

const tool = await m.tools.add(goToTool({ siteLabel: 'the Example docs' }), ks);
await m.intellects.create({
  type: 'internal',
  status: 2,
  tool_ids: [tool.id],
  allow_client_variables: true,
  base_directive: '...',
  prompts: [identityPrompt, siteMapPrompt(manifest), SITE_NAV_RULES_PROMPT, PAGE_CONTEXT_PROMPT],
  capabilities: { ... },
}, ks);
```

| Export | What it is |
|---|---|
| `goToTool({ name?, siteLabel?, timeout?, displayName? })` | The client tool config. Wire shape: `{ name: 'go_to', type: 'client', wait_for_response: false, timeout: 5, args: { path, section } }`. Same options produce the same config, so an upsert by name is idempotent. Pass it to `tools.add()` or `tools.update(id, { config })`. |
| `siteMapPrompt(manifest, { key?, label?, maxTokens?, warn? })` | The SITE MAP prompt block (`type: 'custom'`). |
| `SITE_NAV_RULES_PROMPT` | Frozen prompt block with four rules: call once when a SITE MAP page covers the topic, never call when none does, never two calls per reply, never mention the screen. This wording measured best live across the supported brain models. |
| `PAGE_CONTEXT_PROMPT` | Optional. Renders `{{page_context}}` so the browser can tell the brain which page the visitor is on. Needs `allow_client_variables: true`. See [Dynamic Data Injection](/guides/dynamic-data-injection/). |
| `loadSectionsManifest(url, { fetch?, maxBytes?, timeoutMs? })` | Fetches and validates the manifest at provisioning time. Size-guarded (512 KiB), 15 s timeout, throws `KalturaError` with `code` `bad_arg`, `http_error`, `network_error`, `timeout`, `too_large` or `bad_manifest`. |
| `SITE_NAV_TOOL_NAME` | `'go_to'`. Change the tool name only if you also rewrite the rules prompt. |
| `estimateTokens(text)` | Rough estimate (characters / 3.2) used for the budget warning. |

Prompt order matters: identity first, then SITE MAP, then rules, then page context. Turn `kaltura_genie_experiences` off on the intellect, otherwise the built-in experience tools compete with `go_to`.

Redeploys stay on the same tool id when you look the tool up by name and call `tools.update(id, { config: goToTool() })`. `tools.delete` refuses while an intellect still references the tool, so retire an old tool in a separate explicit step after the intellect's `tool_ids` has moved on.

## Browser plugin

```js
import { SiteNavigator } from '@kaltura/intelligent-agents/experience/site-nav';

const nav = new SiteNavigator({
  session,
  manifestUrl: '/nova/sections.json',
  navigate: (url) => router.push(url),          // SPA
  // navigate: (url) => location.assign(url),   // MPA full reload
  point: (el) => el.classList.add('is-pointed'),
  onNavigate: (info) => analytics.track('go_to', info),
});
// when the session ends
nav.destroy();
```

Construct it once per session, right after the session. `destroy()` unsubscribes everything and is idempotent (`stop()` is an alias). A second live navigator on the same session logs a warning.

| Option | Default | Effect |
|---|---|---|
| `session` | required | Anything with `onToolCall(name, handler)` and `on('turnStart', handler)` returning unsubscribes: `KalturaAvatarSession`, `KalturaChatSession`, `KalturaAgentSession`. |
| `navigate(url, info)` | required | Moves the visitor to `url` (same origin, already validated). Return a promise to delay section scrolling until the new page is in the DOM. Called only for a different page. |
| `manifest` | | Inline manifest. Required unless `manifestUrl` is set. Serves until the fetch resolves when both are set. |
| `manifestUrl` | | Same-origin URL of `sections.json`. Fetched once, size-guarded (`manifestMaxBytes`, default 512 KiB), validated. Calls that arrive before the fetch resolves wait for it. |
| `pathPrefix` | `''` | Deployment prefix (`/docs` on a project Pages site). Prepended to URLs and stripped from `location.pathname`. |
| `scrollTo(el, info)` | `scrollIntoView` smooth/start | Custom scroll. |
| `point(el, info)` | | Highlight hook, called after the scroll. |
| `onNavigate(info)` | no-op | Fires once per tool call with what happened (below). |
| `currentPath()` | `location.pathname` minus prefix | Same-page detection for SPAs with their own router state. |
| `toolCallName` | `'go_to'` | Listen for a different tool name (several navigators, one per embedded product). |
| `oncePerTurn` | `true` | First call that resolves to a page wins; later ones in the same turn drop with `reason: 'once_per_turn'`. Invalid calls never use up the slot. Resets on `turnStart` with `isNewTurn: true`. |
| `updateHash` | `true` | Write `#<section-id>` with `history.replaceState` and append it to the URL given to `navigate`. |
| `settleMs` | `250` | After `navigate` resolves: look up the section now, then next frame, then once more after this delay. |
| `warn(msg)` | `console.warn` | Warning sink. |
| `window` | `globalThis` | Inject a window-like object for tests. |

### Behaviour contract

| Rule | Detail |
|---|---|
| No ACK ever | The plugin never answers the tool call. There is nothing to respond to. |
| Act immediately | The handler runs on the tool segment, whatever the speech state. |
| Path safety | `resolveTarget` must return a manifest page. `resolvePath` first (exact → normalized → last-segment word overlap ≥ 0.5 with a single winner). When no page matches, the last path segment is tried as a section of the page named by the rest of the path; that parent must be an exact or normalized manifest path and the segment must resolve as one of its sections (`splitPath: true`). This catches a brain that fuses `{ path: '/', section: 'license' }` into `{ path: '/license' }`. The final URL passes `safeUrl`. Anything else is dropped with `reason: 'unknown_path'`. |
| Section fallback | key → id → normalized text equality → request words are a subset of one section → Jaccard ≥ 0.5 with a single winner → page top (`fellBackToTop: true`). On a split path the `section` argument wins when it resolves on the parent page, else the split-off segment is the section. A wrong section never fails the navigation. |
| Cross-page | `await navigate(url, info)`, then find the section in the new DOM (now, next frame, after `settleMs`), then scroll, hash, point. |
| Same page | `navigate` is skipped. Scroll, hash, point. |
| One per turn | See `oncePerTurn`. Identical name+args repeats are already dropped by the session itself. |
| Hash | `history.replaceState`, never `location.hash =`, so there is no second scroll. Failures are swallowed. |
| DOM hygiene | Elements are found by id. No selector building, no `innerHTML`, no `eval`. |
| Full reload | When `navigate` reloads the page, the URL already carries `#<id>`, so the browser lands on the anchor natively and this instance dies with the page. |
| Manifest failure | A failed fetch logs one warning and every call drops with `reason: 'no_manifest'`. Nothing throws. |

`onNavigate` receives either a result or a drop:

```js
// resolved
{ path, url, section, sectionId, resolvedBy, fellBackToTop, splitPath, samePage, sectionFound, args }
// dropped
{ dropped: true, reason: 'unknown_path' | 'once_per_turn' | 'no_manifest' | 'unsafe_url', args }
```

### Telling the brain where the visitor is

Send the current page and its keys as `page_context` through `session.setDynamicPrompt()` (or `requestVars` at connect). The manifest already has the keys:

```js
const page = resolvePath(nav.manifest, location.pathname);
session.setDynamicPrompt({ page_context: { url: page.path, sections: page.sections.map((s) => s.key) } });
```

## Adapters

| Host | `navigate` | Manifest source |
|---|---|---|
| Eleventy or any static site generator | `location.assign(url)` if the agent embed survives a reload, else a client-side router | `eleventy.after` hook: parse each written `.html` for `h2[id]` and `data-*-target` elements, call `buildSectionsManifest`, write `_site/nova/sections.json`. |
| SPA (React, Vue, Svelte) | `router.push(url)` returning a promise that resolves after the route renders | Build step over the route table, or a runtime crawl with `document.querySelectorAll('h2[id]')` per route. |
| MPA with the agent in a persistent frame | `frame.location.assign(url)` | Same as static. |
| CMS | `location.assign(url)` | Export headings per page from the CMS API into `PageInput[]`. |

## Taking it to another app

1. Produce `sections.json` with `buildSectionsManifest` from whatever you have. Only `path` is mandatory per page. Publish it at a public, same-origin URL.
2. Provision: `tool_ids: [ (await tools.add(goToTool({ siteLabel }), ks)).id ]`, prompts `[identity, siteMapPrompt(manifest), SITE_NAV_RULES_PROMPT, PAGE_CONTEXT_PROMPT]`, `allow_client_variables: true`, `kaltura_genie_experiences` off.
3. Browser: `new SiteNavigator({ session, manifestUrl, navigate })`.
4. Optional: `point` for a visual pointer, `onNavigate` for analytics, `lang` and `stopWords` for a non-English site, `overrides` for keys that read badly.

Extensibility hooks that cost nothing today:

| Hook | Purpose |
|---|---|
| `manifest.version` | Format evolution. |
| `section.kind` | `heading`, `target`; future kinds (`tab`, `step`) resolve through the same chain. |
| `overrides` | Hand-fix a weak key. |
| `depth` | Include h3 keys on a small site. |
| `stopWords[lang]` | Localized sites. |
| `toolCallName` | Several navigators on one session. |
| `maxTokens` | Keeps very large sites honest. Split the site or lower `depth` when it fires. |

Non-goals: multi-argument actions (`action: 'open' | 'highlight'`), server-side routing, search over page bodies, replacing the knowledge base. One tool, two args.

## Testing

- `npm test` covers the key algorithm, manifest build/validate/resolve, the prompt builders and the browser plugin offline (`test/unit/site-keys.test.js`, `test/unit/site-nav-management.test.js`, `test/unit/site-nav.test.js`). `test/fixtures/site-map.snapshot.txt` pins the rendered SITE MAP for the docs site so a key change is a visible diff.
- `npm run live-verify:site-nav` (`scripts/live-verify-site-nav.mjs`) runs against the real Kaltura API: tool echo shape, idempotent update, prompt echo, one mapped ask producing exactly one resolvable `go_to`, one unmapped ask producing none, then deletes everything it created. CI runs it on every merge and on PRs labelled `run-live-verify`. Tool names are unique per partner, so on a partner that already runs a live `go_to` tool the script records a skip, exits 0, and leaves that tool untouched. Point `AGENTIC_PARTNER_ID` at a partner without a live `go_to` deployment to run it for real.

## Security

- Only manifest paths are navigable. The model cannot invent a destination.
- Every URL handed to `navigate` and every manifest URL passes `safeUrl`.
- A fetched manifest is size-guarded, parsed, passed through `sanitizeJson` (prototype keys dropped) and validated before use, on both the server and the browser side.
- No `innerHTML`, no selector strings built from model output, no `eval`.
- The manifest is public data. Keep internal or unpublished pages out of the build input.

## Related docs

| Doc | What it adds |
|---|---|
| [README.md § Site navigation](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#site-navigation-sitenavigator) | Quick start and export tables. |
| [Client-Side Commands](/guides/client-commands/) | The general client-command contract this tool is built on, and why waiting tools spiral. |
| [Dynamic Data Injection](/guides/dynamic-data-injection/) | `page_context` and the other ways to keep the brain in sync with the page. |
| [Security](/reference/security/) | The output-handling rules the plugin follows. |


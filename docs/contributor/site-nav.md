> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Site navigation: tests, extension points and scope

What a contributor needs when changing the `go_to` site navigation code. App-facing behavior is in [SITE-NAV.md](../SITE-NAV.md).

## Testing

- `npm test` covers the key algorithm, manifest build/validate/resolve, the prompt builders and the browser plugin offline (`test/unit/site-keys.test.js`, `test/unit/site-nav-management.test.js`, `test/unit/site-nav.test.js`). `test/fixtures/site-map.snapshot.txt` pins the rendered SITE MAP for the docs site, so a key change is a visible diff.
- `npm run live-verify:site-nav` (`scripts/live-verify-site-nav.mjs`) runs against the real Kaltura API: tool echo shape, idempotent update, prompt echo, one mapped ask producing exactly one resolvable `go_to`, one unmapped ask producing none. It then deletes everything it created. CI runs it on every merge and on PRs that touch its paths, except fork and Dependabot PRs, which get no secrets.
- The script names its throwaway tool `go_to_<run tag>`, so it never collides with a live `go_to` tool on the same partner.

## Extension points

| Hook | Purpose |
|---|---|
| `manifest.version` | Format evolution. |
| `section.kind` | `heading` or `target`. |
| `overrides` | Hand-fix a weak key. |
| `depth` | Include h3 keys on a small site. |
| `stopWords[lang]` | Localized sites. |
| `toolCallName` | Several navigators on one session. |
| `maxTokens` | Caps the site map's size on very large sites. Split the site or lower `depth` when it fires. |

## Non-goals

Multi-argument actions (`action: 'open' | 'highlight'`), server-side routing, search over page bodies, replacing the knowledge base. One tool, two args.

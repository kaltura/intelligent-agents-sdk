# Changelog

All notable changes to `@kaltura/intelligent-agents` are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows [Semantic Versioning](https://semver.org/).

## [1.0.2]

### Security

`Http.request()`'s `maxResponseBytes` guard now enforces the limit incrementally while
streaming the response body, instead of buffering the full body via `res.text()` first —
closes a memory-exhaustion path for a chunked response with no honest `Content-Length`.

`net-guard.js`'s SSRF host check now also blocks IPv6 unique-local (`fc00::/7`), IPv6
link-local (`fe80::/10`), and IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d` and the
URL-normalized hex-hextet form) — closes bypasses that skipped the IPv4-only
private-range check.

`safeUrl` now rejects URLs carrying embedded userinfo credentials
(`https://user:pass@host/...`) — closes a phishing/link-spoofing vector distinct from the
existing scheme allowlist.

## [1.0.1]

### Fixed

`respondToTool()` now also sends `tool_invocation_id` (echoing the same id as
`tool_id`) on its `POST /assistant/tool_response` ack. The conversation-manager
backend added this as a second required field independently of `tool_id`; a
request missing it 422s, so the client's ack for a `waitForResponse:true` tool
call was silently rejected. The brain then fell back to its own tool-call
timeout before continuing the turn, producing a multi-second stall and, once
the fallback response arrived, an answer that ignored the tool's real result.

## [1.0.0] — Unreleased

### Added

Initial version. Not yet published to npm or opened to the public — see
[README.md](README.md) for current repo status and entry points.

# The avatar-media browser harness

`avatar-media.html` proves the merged-stream media path (`src/experience/avatar-media.js`) in a real browser engine, through the public session API only. Node tests cannot cover it: autoplay policy, `setSinkId`, `MediaRecorder`, element capture and `requestVideoFrameCallback` only exist in a browser, and each engine implements them differently.

It is fully offline. Both WebRTC legs are loopback peers inside the page, the signalling socket is `../fakes/socket.js`, WHEP is an injected `fetch`, and the mic is a synthetic tone. No credentials, no network, and audio is near-silent with the browsers launched muted.

`../../scripts/README.md` covers the three verification tiers and where this one sits. This file is about the page itself.

## Run it

```bash
npm run verify:avatar-media                                    # chromium
VERIFY_BROWSER=firefox npm run verify:avatar-media             # chromium | firefox | webkit
VERIFY_AVATAR_MEDIA_ONLY=shapes-simple,swaps npm run verify:avatar-media
VERIFY_AVATAR_MEDIA_DEBUG=1 npm run verify:avatar-media        # mirror page console to stdout
```

`scripts/verify-avatar-media.mjs` serves the repo, opens the page, runs every cell in order, and exits non-zero on the first problem. Results land in `.harness-output/avatar-media-<engine>.json` (gitignored).

| Env var | Effect |
|---|---|
| `VERIFY_BROWSER` | Engine. Default `chromium` |
| `VERIFY_AVATAR_MEDIA_ONLY` | Comma-separated cell names. Runs only those |
| `VERIFY_AVATAR_MEDIA_DEBUG` | Print every page console message |
| `VERIFY_AVATAR_MEDIA_PORT` | Static-server port. Default `4789` |

Budgets: 30 s per cell, 90 s for the whole run. A cell that needs longer is doing too much.

### By hand

Serve the repo root on any port, open `/test/browser/avatar-media.html`, click **start**, then drive it from the console:

```js
window.__scenarios            // every cell name
await window.__run('swaps')   // { name, pass, checks, skipped, lat, ms }
```

Useful for one stubborn cell, especially in a headed Safari or Firefox where the engine differs from the Playwright build. `start` also resumes the `AudioContext`, which the energy checks need.

## The page contract

The runner only touches these:

| Surface | What it is |
|---|---|
| `window.__scenarios` | Array of cell names, in page order |
| `window.__run(name)` | Runs one cell, resolves the result, also parks it on `window.__result` |
| `window.__result` | Last result. The runner nulls it before each cell |
| `window.__gestureWanted` | A cell set it and is waiting for a real user gesture |
| `#go` | Marks the page ready and resumes the `AudioContext` |
| `#resume` | The user gesture: lifts every autoplay block |

Autoplay cells park on `__gestureWanted` instead of faking a gesture. The runner waits for either `__gestureWanted` or `__result`, and clicks `#resume` when the cell is waiting. A synthetic event would not satisfy the engine's own policy, so the click has to be real.

Every cell also gets two checks it did not write:

- `no unhandled rejections`, compared against the count before the cell started.
- `B12: every subscribe reached mediaReady within 2500ms of its first track`, from the per-connect latency probe.

`__run()` always calls `cleanup()` at the end: it disconnects every live session, closes every peer, clears the stage, and resets the whole `H` state object. Cells never leak into each other, so they can run in any order or alone.

## Adding a cell

1. Add `S['your-cell'] = async (c) => { … }` in `avatar-media.html`, near the cells it belongs with.
2. Add the same name to `EXPECTED_CELLS` in `../../scripts/verify-avatar-media.mjs`, in page order.

The list is a gate: a cell renamed, added or dropped without updating it fails the run. That is the point, so a scenario cannot quietly disappear.

Use the existing helpers rather than new plumbing:

| Helper | Gives you |
|---|---|
| `connected(cfg, script)` | A connected session plus `{ session, socket, ev, connectMs, rescript }` |
| `newSession(cfg, script)` | The same session, not yet connected |
| `record(session)` | Event log with `count(name)`, `of(name)`, `idx(name)`, `t[name]` |
| `makeEl('video' \| 'audio')` | An instrumented element. `el.__w` counts writes to `srcObject`, `play`, `muted`, `volume` |
| `paints(el)`, `flowing(pc, kind)`, `advancing(el)` | Real media actually moving |
| `rms(stream)`, `elementRms(el)` | Audio energy through Web Audio |
| `stv(session)` | The downlink peer, for `getStats()` |
| `kinds(streamOrEl)`, `liveTracks(tracks)`, `ended(tracks)` | Track shape assertions |

`shapes-simple` is the shortest complete example. Assert on what a caller observes: session state, public getters, emitted events, element properties, write counts, WebRTC stats. Never on session internals beyond the `stv()` probe the page already owns.

`c.check(label, ok, detail)` records a check. `detail` shows up in the failure output, so pass the actual value, not a restated label.

## Engine differences

Engines really do differ, and the harness refuses to hide it:

- `c.skip(label, reason)` when an engine cannot run a check.
- Every skip must match an entry in `ALLOWED_SKIPS` in `verify-avatar-media.mjs`: `{ cell, check, reason: RegExp, engines? }`. An unlisted skip, or a reason that does not match, fails the run, so "unsupported in this engine" can never grow into "we stopped testing this".
- Leave `engines` off unless the gap is genuinely engine-specific. One engine name covers different builds: macOS WebKit has `setSinkId` and `MediaRecorder`, the headless WebKit build on CI has neither.

`has` at the top of the page holds the feature detection (`setSinkId`, `mediaRecorder`, `canvasCapture`, `elementCapture`, `elementSource`). Branch on it, not on a user-agent string.

A `Bn` prefix on a check name marks a real-browser behavior this tier exists to pin down. The numbers are local to this harness; the comment beside each one says which behavior it is.

## CI

`ci.yml` runs this page on all three engines in parallel and uploads each engine's JSON. Run at least Chromium locally before pushing a change to `src/experience/avatar-media.js` or to this page.

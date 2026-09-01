# Manual test plan: `session_completed` lifecycle signal

This covers everything about the `session_completed` signal (`src/experience/session-complete.js`) that automation can't verify. The automated coverage — `npm run live-verify:session-complete`, run against Chromium, Firefox, and WebKit on every merge (see `scripts/live-verify-session-complete.mjs` and `.github/workflows/live-verify.yml`) — already proves the mechanism works correctly across desktop browser engines, against the real Kaltura backend. What it *can't* reach is real mobile OS behavior: Playwright's `webkit` engine is desktop Safari's rendering engine, not the real iOS Safari runtime, and no browser-automation tool can simulate real OS-level backgrounding, memory-pressure tab kills, or force-quit. That gap is what this folder is for.

## What you're testing

When a conversation ends, the SDK POSTs `{genieUrl}/thread/session_completed` so the backend's lifecycle rules (summaries, insights, CRM pushes) fire within seconds instead of waiting for the ~10-minute idle scanner. The full design rationale, config options, and decision table live in `README.md`'s "Ending a conversation cleanly (`session_completed` signal)" section at the repo root — read that first if you haven't. The short version: it fires on tab-close (`pagehide`), on a back-forward-cache freeze, after 30 seconds of being hidden (the mobile-tab-kill fallback), on an explicit `disconnect()` or `completeThread()` call — and it's idempotent and suppressed while another tab on the same device still has the thread open.

## Setup

1. From the repo root, export `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` (or drop a `.env` file in the repo root — same convention as `scripts/live-verify-session-complete.mjs`).
2. Run:

   ```bash
   node manual-testing/session-complete/mint.mjs
   ```
   This mints a throwaway intellect and a 4-hour conversation token, then serves the test app over your LAN and prints a URL like `http://192.168.x.x:4787/manual-testing/session-complete/app.html?token=...`.
3. Open that URL on each device you're testing. All devices must be on the same Wi-Fi network as the machine running `mint.mjs` (it binds to your LAN IP, not just localhost). For a device that can't reach your LAN (a real cellular connection, a separate network), tunnel the port instead — e.g. `ngrok http 4787` — and use the tunnel's HTTPS URL in place of the LAN one printed above (some mobile browser features, like BroadcastChannel-based presence, work identically over HTTP or HTTPS, but prefer HTTPS when tunneling since it's closer to a real production deployment).
4. When you're done testing, press Ctrl+C in the `mint.mjs` terminal. It deletes the throwaway intellect automatically.

Leave the `mint.mjs` terminal visible for the whole session — it's your primary source of truth (see below).

## Why the terminal log is the one that counts

The app's `genieUrl` is pointed back at `mint.mjs` itself (`location.origin`), which transparently proxies every real `/assistant/*` and `/thread/*` call through to the real production backend. That's deliberate: for the flows this document exists to test — a tab that gets killed, a phone that gets locked, a browser that force-quits — the page may die before it gets a chance to render, log, or run any JavaScript at all. The on-page log panel is convenient for the golden-path flows where the page survives, but the `mint.mjs` terminal is the only log that's guaranteed to show what actually happened, because it's server-side and unaffected by the page's own death. For every flow below, treat a terminal line like this as the real result:

```
[2026-09-01T17:14:57.449Z] session_completed  thread=<id>  auth=present  from=<ip>
```

...and the absence of one, after enough time has passed for the flow under test, as a real failure — not "the page just didn't get to log it."

## Using the app

- **Connect**, **Send test turn**, **Disconnect (final)**, **Disconnect (final:false)**, **Complete thread (no teardown)** map directly to the SDK calls of the same name — see the inline comments in `app.html` for exactly which method each button calls.
- The status panel shows live `state`, `threadId`, `document.visibilityState`, `navigator.onLine`, and the configured `hiddenGraceMs`.
- Once a thread exists, an "Open same thread in a new tab" link appears — use it for the multi-tab presence flows below instead of manually copying the URL, since it carries the `threadId` query param that seeds the second tab onto the same thread.
- `hiddenGraceMs` can be overridden via `?hiddenGraceMs=5000` in the URL if you want a faster grace-period test than the 30-second default — just note in your results whether you used the override.

## Manual flows

For each flow: do the steps, then check the `mint.mjs` terminal for the expected result before moving on.

### 1. Golden path

Connect → Send test turn → Complete thread (no teardown). Expect exactly one `session_completed` terminal line, and the on-page log shows `sessionCompleted: {"sent":true,...}`.

### 2. Real tab/window close

Connect → Send test turn → close the tab (or the whole browser window) using the OS/browser's own close control — not the Disconnect button. Expect one `session_completed` terminal line within a second or two of closing, with `reason` reflecting a `pagehide` fire (check the SDK's own audit log if you have access to it; the terminal line itself doesn't carry the reason, only that the POST landed).

### 3. Real backgrounding, then wait past the grace period

Connect → Send test turn → background the app (switch to another app, or press the phone's home button — don't close the tab) → wait at least 35 seconds (5 seconds past the default 30-second `hiddenGraceMs`) → check the terminal. Expect one `session_completed` line appearing without ever bringing the tab back to the foreground. This is the primary mobile-tab-kill mitigation — it's what catches the case where iOS Safari or Chrome Android kills the page's process while it's hidden, before a real `pagehide` event could ever fire.

### 4. Backgrounding, then return before the grace period expires

Connect → Send test turn → background the app → wait 10 seconds → return to the foreground → wait another 30 seconds. Expect **no** `session_completed` line — returning to the foreground before the grace period elapses must cancel the pending completion. Then tap Disconnect to confirm the session is still alive and can still complete normally.

### 5. Force-quit / OS-level kill

Connect → Send test turn → force-quit the browser app entirely (iOS: swipe up in the app switcher; Android: swipe away from recents) immediately, well before the 30-second grace period would elapse on its own. This is the one flow with an accepted gap: if the OS kills the process before `hiddenGraceMs` elapses, no signal can fire from the client at all, and the backend's ~10-minute idle scanner is the real fallback. Record whether the terminal shows a line within the grace window regardless (sometimes the OS gives the backgrounded page enough time to still fire before actually suspending it) — either outcome is informative, but a missing line here is not a bug, it's the documented limit of client-side signaling.

### 6. Real back-forward-cache round trip

Connect → Send test turn → navigate to a different page (type a new URL, or tap a link) → use the browser's **back** button to return. Expect one `session_completed` line appearing around the moment you navigate away (the SDK can't survive a bfcache freeze, so it completes immediately rather than trying to resume). Confirm the page that comes back via bfcache shows a stale/closed session rather than pretending the old one still works.

### 7. Multi-tab presence suppression

Connect → Send test turn → tap "Open same thread in a new tab" → in the **original** tab, tap Disconnect (final). Expect **no** `session_completed` line yet — the other tab is still open, so the signal is suppressed. Now close the **second** tab too (real close, not Disconnect). Expect exactly one `session_completed` line to appear now, once the last tab standing closes. Also try the reverse order (close the second tab first, then disconnect the first) to confirm suppression works symmetrically.

### 8. In-app webview / no-BroadcastChannel fallback

Open the test URL inside an in-app browser that lacks `BroadcastChannel` support (a common gap in some in-app webviews embedded in native apps — e.g. certain versions of embedded webviews used by social apps). Connect → Send test turn → Disconnect. Expect the signal still fires normally — with no `BroadcastChannel`, the SDK can't track peers, so it degrades to "just send it" rather than failing. If you don't have access to such a webview, note that in your results rather than skipping the row silently.

### 9. Offline / airplane mode during disconnect

Connect → Send test turn → enable airplane mode (or otherwise cut network) → immediately tap Disconnect (final). Expect the on-page log to show `disconnect() returned` (it's synchronous and always returns immediately) but **no** corresponding terminal line, since the POST itself can't reach the network. Then disable airplane mode and wait roughly 10 minutes if you want to confirm the backend's own idle-scanner fallback eventually closes the thread server-side — this is optional and slow, mark it as skipped if you don't have time.

### 10. Low-power / battery-saver mode

Enable the device's battery-saver or low-power mode, then repeat flow 3 (background + wait past grace period). Some mobile OSes throttle background JavaScript timers more aggressively in this mode. Expect the same result as flow 3; if the terminal line takes noticeably longer to appear than 30 seconds, note the actual delay.

### 11. Slow/flaky network

Throttle the connection (browser devtools network throttling, or a real poor-signal environment) to something slow, then tap "Complete thread." `sessionCompleteTimeoutMs` (default 5000ms) governs how long this specific call waits before giving up — confirm the button's on-page log resolves or errors within roughly 5 seconds even under throttling, rather than hanging indefinitely. Note that this timeout does **not** apply to the tab-close/backgrounding paths, only to `completeThread()`'s deliberate call.

### 12. Manual `completeThread()` without teardown

Connect → Send test turn → tap "Complete thread (no teardown)" → confirm the session is still `state: connected` afterward (check the status panel) and you can still tap "Send test turn" again successfully. Then tap "Complete thread" a second time — expect the on-page log to show `{"ok":true,"reason":"already_sent"}` immediately, with **no** second terminal line, confirming the idempotency guarantee.

## Device/browser coverage matrix

Run at minimum the golden path (flow 1) and the mobile-specific flows (3, 4, 6, 7) on each row below before signing off a release. The desktop engines are already covered continuously by CI (see the top of this document) — re-testing them here is optional, included mainly as a sanity check if you suspect the automated coverage missed something.

| Device / browser | Priority | Notes |
|---|---|---|
| iOS Safari | Required | Primary target for the hidden-grace and bfcache flows. |
| iOS Chrome | Required | Runs on WebKit under the hood on iOS — confirm it behaves like Safari, not like desktop Chrome. |
| Android Chrome | Required | Primary target for real OS-level tab kill. |
| Desktop Chrome | Optional | Already covered by CI. |
| Desktop Firefox | Optional | Already covered by CI. |
| Desktop Safari | Optional | Already covered by CI (via WebKit), but real Safari can differ from Playwright's WebKit build — worth spot-checking after a Safari version bump. |
| Android Firefox | Nice to have | |
| Samsung Internet | Nice to have | Common default browser on Samsung devices; worth checking once per release cycle. |
| One in-app webview (e.g. Instagram/Facebook in-app browser) | Required | Covers flow 8 — the no-`BroadcastChannel` fallback. |

## Results log

Copy this table into your test run notes and fill in one row per device/flow combination.

| Date | Tester | Device/browser | Flow # | Result | Notes |
|---|---|---|---|---|---|
| | | | | pass / fail / skipped | |

# Manual test plan: voice/video avatar pipeline

This covers the real avatar pipeline (mic capture → ASR uplink → STV/WHEP video downlink → chroma-key compositing) that automation genuinely can't reach. Read this first so you don't waste time re-testing what's already covered:

## What's already automated (don't re-test these)

- **Noise-suppressor DSP correctness** — `npm run verify:noise-suppressor`, a real AudioWorklet run in real headless Chromium, Firefox, and WebKit, asserting the gate passes loud audio and attenuates quiet audio. Runs on every push (`.github/workflows/ci.yml`, `noise-suppressor` job). No network, no live credentials.
- **WHEP video decode + chroma-key correctness, mic-to-ASR audio flow, on Chromium, Firefox, and WebKit** — `scripts/live-verify-browser.mjs`, against the real Kaltura backend, on `merge_group`/`run-live-verify` (`.github/workflows/live-verify.yml`, `live-verify-browser` job). Asserts the composited canvas is actually painting varying, partially-transparent frames (real chroma-keying, not a blank or fully-opaque frame) and that real mic audio actually reaches a peer (`RTCPeerConnection.getStats()` outbound-rtp `bytesSent > 0`).
- **`session_completed` lifecycle signal, all three engines** — separate mechanism, separate test plan: see `manual-testing/session-complete/README.md`.
- **presenter.js / chroma-key.js SDK-side wiring** — unit-tested (`test/unit/`), mocked transport.

## Confirmed defects this automation found and fixed

- **WebKit TURN URL rejection.** Extending the above to a real WebKit backend run surfaced a real bug: WebKit's native `RTCPeerConnection` rejects any `?transport=` query string on a `turn:`/`turns:` ICE server URL (`KalturaError: Invalid TURN URL query string`, thrown synchronously — no connection ever attempted). `src/experience/wire.js`'s `createPeerConnection()` now retries once with those query strings stripped when it sees this exact error; `turnServers()`'s 4 URLs still cover 3 of 4 paths that way (UDP:80, UDP:443, TURNS/TCP+TLS:443 all default correctly without the query string — only the plain-TCP-on-80 fallback has no query-less spelling and is lost on this engine). Verified fixed against the real backend on WebKit. Covered by `test/unit/wire.test.js`.
- **Firefox missing H264.** Playwright's bundled headless Firefox has no H264 in `RTCRtpReceiver.getCapabilities('video')` until its OpenH264 GMP plugin is fetched, which doesn't happen by default in that launch profile. The Kaltura SRS WHEP server only serves H264 video, so without it the server answers Firefox's VP8/VP9/AV1 offer with `a=inactive` on the video m-line (confirmed via SDP inspection and `getStats()` — ICE/DTLS connect fine, only video is dropped). Fix: `live-verify-browser.mjs` enables the GMP fetch via `firefoxUserPrefs` (`media.gmp-manager.updateEnabled`, `media.gmp-provider.enabled`, `media.gmp-gmpopenh264.enabled`/`autoupdate`) and waits for `RTCRtpReceiver.getCapabilities('video')` to report H264 before navigating — measured 20-40s against Mozilla's real update service across repeated runs, so the wait budget is 120s. Verified fixed against the real backend on Firefox, repeatedly.

## Setup

1. From the repo root, export `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` (or drop a `.env` file in the repo root).
2. Run:
   ```bash
   node manual-testing/voice-video/mint.mjs
   ```
   This provisions a throwaway agent+avatar+intellect, serves the real unmodified `examples/chroma-key-avatar.html` (plus a real `/appInit` route) over your LAN, and prints a URL like `http://192.168.x.x:4789/examples/chroma-key-avatar.html`.
3. Open that URL on each device you're testing — same Wi-Fi network as the machine running `mint.mjs`. For a device that can't reach your LAN, tunnel the port instead (e.g. `ngrok http 4789`).
4. Grant microphone permission when prompted. The page shows the composited, chroma-keyed avatar and a disclosure banner once connected.
5. When done, Ctrl+C in the `mint.mjs` terminal — it deletes the throwaway agent/avatar/intellect automatically.

## Manual flows

### 1. Real desktop Firefox, full pipeline

Open the URL in real desktop Firefox with its default settings (not the Playwright-bundled build, and don't touch `media.gmp-gmpopenh264.enabled`). Confirm real video renders (not a blank/frozen frame) and the chroma-key correctly removes the green background. CI already covers this on Playwright's Firefox build (see "Confirmed defects" above); this flow is a sanity check that a real, unmodified Firefox install behaves the same way. Note the Firefox version tested.

### 2. Real Safari (macOS and iOS)

Playwright's `webkit` engine is desktop Safari's rendering engine, not the actual Safari app, and iOS Safari isn't reachable by any Playwright engine at all. Open the URL in real Safari on macOS, and in real Safari on an iPhone/iPad. Confirm connection succeeds (this is exactly the TURN-URL fix's real-world test — a regression here would mean the fix doesn't hold on real Safari the way it did on Playwright's WebKit) and video/chroma-key render correctly.

### 3. Real hardware/OS interrupts

None of these are reachable from a scripted browser:

- **Bluetooth audio device switch mid-call** — connect on a device's built-in mic/speaker, then connect a Bluetooth headset mid-conversation. Confirm audio continues (possibly with a brief gap) rather than the session dying.
- **Mic permission revoked mid-session** — start a conversation, then revoke microphone permission from the OS/browser settings without reloading the page. Confirm the SDK surfaces a clear error/state change rather than hanging silently.
- **Incoming phone call (mobile)** — start a conversation on a phone, then receive a real call. Confirm the mic/session recovers (or fails cleanly) once the call ends.
- **Screen lock / unlock (mobile)** — lock the screen mid-conversation, then unlock. Confirm the video resumes or the session ends cleanly — don't accept a silently frozen frame.
- **Device rotation (mobile)** — rotate the device mid-conversation. Confirm the composited video's layout adapts rather than clipping or distorting.

### 4. Subjective/perceptual quality

Automation confirms the noise gate's *math* is correct (loud passes, quiet is attenuated) and that chroma-keying produces varying, partially-transparent frames — neither proves the result actually looks/sounds good to a person:

- **Chroma-key edge quality on a real green screen** — uneven lighting, screen wrinkles, hair/glasses edges, green spill on skin. The synthetic checks use a server-rendered avatar already composited server-side; do a real visual pass on the final on-screen result across a couple of different backgrounds/lighting setups.
- **Noise-suppressor perceived quality** — real room noise (fan, traffic, keyboard clatter) at conversational volume, not synthetic tones. Confirm speech stays intelligible and the gate doesn't audibly "pump" or clip word onsets.

### 5. Real-world network conditions

Devtools network throttling simulates bandwidth/latency, not the actual failure modes of real networks:

- **Hotel/public Wi-Fi** with captive portals or aggressive UDP filtering — confirm the TURN fallbacks (TCP/TLS on 443) actually kick in when UDP is blocked, not just in theory.
- **Corporate proxy/VPN/NAT** — test from inside a corporate network with a VPN client active, and from behind a symmetric NAT if you have access to one, since these are exactly the conditions the 4-URL TURN fallback exists for.
- **Real packet loss** — a real degraded connection (rural cellular, congested Wi-Fi), not a devtools-simulated one, to see how the avatar pipeline actually degrades (frozen frame vs. graceful drop vs. reconnect).

### 6. GenUI real-device rendering checklist

A lighter pass, since GenUI widget logic itself is unit-tested — this is purely "does it render correctly on a real small screen":

- Trigger a couple of different GenUI widget types (see `docs/GENUI-REFERENCE.md`) on a real phone screen and a real tablet screen. Confirm layout, tap targets, and text sizing are usable, not just "present."

## Device/browser coverage matrix

| Device / browser | Priority | Notes |
|---|---|---|
| Desktop Firefox (real, default config) | Required | Already covered by CI post-fix (see "Confirmed defects" above); re-testing here is a sanity check only — flow 1. |
| iOS Safari | Required | Not reachable by any Playwright engine. |
| macOS Safari | Required | Real engine differs from Playwright's `webkit` build. |
| Android Chrome | Required | Primary target for flow 3's mobile interrupts. |
| Desktop Chrome | Optional | Already covered by CI. |
| Desktop Safari via WebKit engine equivalent | Optional | Already covered by CI post-fix; re-testing here is a sanity check only. |

## Results log

Copy this table into your test run notes and fill in one row per device/flow combination.

| Date | Tester | Device/browser | Flow # | Result | Notes |
|---|---|---|---|---|---|
| | | | | pass / fail / skipped | |

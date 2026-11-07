# Showroom: a full-body in-store agent

> **Closed experiment.** The clip-based body did not look natural enough. Findings are in [EXPERIMENT-REPORT.md](EXPERIMENT-REPORT.md). This branch is kept for reference and is not for merge.

A reference app for the SDK. Juno, a robot guide at the fictional phone shop Gizmo Grove, talks with one customer at a time. The customer can speak, tap, or mix both. Phone, tablet, laptop and a tall kiosk screen all work.

## Run it

| Goal | Command | Open |
|---|---|---|
| Try it with no account (scripted demo) | `node examples/showroom/server.mjs` | `http://127.0.0.1:8092/examples/showroom/index.html?demo` |
| Run it live | provision once, then start the server with credentials | same URL without `?demo` |

```bash
export AGENTIC_PARTNER_ID=…
export AGENTIC_ADMIN_SECRET=…
node examples/showroom/agent/provision.mjs   # creates Juno, writes agent/agent.json (ids only, git-ignored)
node examples/showroom/server.mjs            # mints widget tokens; the admin secret stays in this process
```

`provision.mjs` is safe to run again. It updates in place. `--cleanup` deletes everything it created.

Requirements: Node 18 or newer (the live voice script's `--env-file` needs 20.6), and a clone of this repository (the video bodies in `bodies/` are not in the npm package, so without them the page uses the drawn robot). `AGENTIC_URL`, `GENIE_URL` and `OVP_URL` point both scripts at a different backend. Set them for both, or for neither.

Juno's face is `agent/juno.jpg`, an AI-generated portrait of a fictional person. The first run uploads it as a custom visual (`catalog.createVisual`) and builds the avatar from it. Swap the file and the attributes in `AVATAR_LOOKS` (`agent/spec.mjs`) to change the face. Portrait rules: square, at least 2048 px, head about a quarter of the height, centered, front-facing, mouth closed, plain background to every edge.

## Query flags

| Flag | Effect |
|---|---|
| `?demo` | Scripted session. No network, no credentials. Add `&fast` for short timings |
| `?kiosk` | After idle time, shows a warning, then clears the cart and returns to the welcome screen |
| `?idle=<ms>` `&warn=<ms>` | Kiosk idle time (default 90000) and warning time (default 15000) |
| `?color=<hex>` | Accent color, six hex digits |
| `?theme=light` | Bright shop scene with dark text and white glass. Default is the dark theme |
| `?body=<folder>` | Use the video-clip body in `bodies/<folder>/`. The default is `guide`. `?body=rig` uses the drawn SVG robot, which needs no video files |

## How it fits together

```
 voice ─ session.onToolCall ─┐                         ┌─ Body (video clips or SVG rig)
                             ├─ actions ─ store ─ UI ──┤
 touch ─ tap ────────────────┘            │            └─ live avatar <video> in the head slot
                                          └─ request vars (screen, cart) ─ agent
 tap ─ short note, batched ─ session.speak ─ agent reacts
```

| Part | Where | Rule |
|---|---|---|
| State | `js/reducer.js`, `js/store.js` | One pure reducer. A voice tool call and a tap dispatch the same actions |
| Tools | `js/tools.js` | One spec list. It drives the in-app handlers and the platform tool configs |
| Bridge | `js/bridge.js` | The only file that knows both the session and the store. Runs under tests with `DemoSession` |
| Suggested questions | `js/panel.js` | The agent calls the `suggest_next` tool. Chips draw with the SDK's `mountWidget` (`followups` kind). A tap sends the question as speech. A new agent turn or a touch clears them. The platform's own follow-up widget needs `kaltura_genie_experiences` on, which competes with client tools, so the app uses a tool instead |
| Body | `js/rig/` | `clip-body.js` plays a photoreal figure from video clips (default). `rig.js` is the same contract as a drawn SVG robot. See below |
| Motion | `js/rig/director.js`, `js/rig/layers.js` | The director wraps the body and decides the unprompted moves: hand gestures while she talks (never the same one twice, an open hand after a question, none when the voice stops), nods while the customer talks, a head tilt while she thinks, a slow tilt or nod and a drifting idle rate while she waits. `joins.js` plans seamless joins: a gesture starts when the idle loop reaches a pose that looks like one of its first frames, and hands back at a frame that looks like an idle pose (the idle loop is seeked there first), so the 120 ms cross-fade shows no jump. A gesture can start up to about a second after it is asked for. Talking gestures play a little slower than filmed and ease in and out of their speed, and head nods and tilts are small and critically damped, so nothing moves on a fixed beat. `layers.js` holds two gesture slots with equal-rate weights. All three are pure and run under tests, the director with a seeded random source |
| Layout | `js/layout.js` | `wide`, `tall` and `phone`, chosen from the viewport. On a tall kiosk she stands full-body at life size on the left and the scene is a column beside her. One design unit scales everything. Font never goes under 14 px |
| Start | `js/main.js`, `js/retry.js`, `js/bridge.js` | The SDK, socket.io and a token load while the welcome card shows. After the tap, Juno is grey and dim and a "Juno is joining" notice shows, with the attempt number on a retry. A failed start is tried three times (0.4 s, then 0.8 s apart) before the error and the "Try again" button show. When the session is up she turns to full colour, waves and the chip reads "Juno is here". The agent greets by itself (`opening_phrase`). If that greeting has not begun 5 s later, the app asks Juno to introduce herself |
| Agent | `agent/spec.mjs` | Prompts, tools, capabilities and avatar looks as plain data. Linted with the SDK linters before anything is written |

## Scene background

The stage sits on a photo of a shop floor (`assets/store.webp` for portrait screens, `assets/store-wide.webp` for landscape, switched by `@media (min-aspect-ratio: 1 / 1)` in `styles/stage.css`). Both are AI-generated (a warm boutique with an arched feature wall, pendant lights and white demo tables), unbranded, and each is under 80 KB. Swap in your own files with the same names, or set the `--scene` custom property in `styles/stage.css` to another image.

A dark grade sits over the photo so the light panel text stays readable. `?theme=light` puts a white veil over the same photo and switches to dark text. It is one block at the end of `styles/stage.css` that overrides the color tokens in `styles/tokens.css`. For your own theme, copy that block.

Two soft layers add depth: a vignette over the stage edges and a spotlight behind the figure (`--vignette` and `--spot` in `styles/stage.css`, set per theme).

The head does not need a dark scene: the live video is cut out of its backdrop by a matte (`head-matte.png`), so it sits on any background.

## Bring your own body

The default body is `bodies/guide/`: a fictional store guide, filmed as AI-generated green-screen video and keyed to a real alpha matte. Her head is erased from every clip. The live avatar video draws it, using the same person's portrait, so head and body read as one figure. Before a session starts, `head.jpg` (the avatar's first frame) fills the same spot. Each clip is 1 to 2 MB (the idle loop 4 to 7 MB), and a browser loads one format.

A body is a folder with `manifest.json` and one `.webm` (VP9) plus one `.mp4` (H.264) per clip:

```json
{ "aspect": [1080, 1920],
  "packed": true,
  "tracked": true,
  "head": { "left": 0.347, "top": 0.0918, "width": 0.299, "height": 0.168 },
  "seam": [0.239, 0.2561],
  "fit": { "scale": 0.86, "dx": 0.0056, "dy": -0.0056 },
  "floor": { "y": 0.943, "width": 0.2 },
  "still": "head.jpg",
  "idle": "idle",
  "joins": "joins.json",
  "clips": { "wave": "wave", "present": "present-right", "beat": "beat" } }
```

| Field | Meaning |
|---|---|
| `head` | Where the live avatar video goes, as fractions of the frame. Make it a square that holds the head, the neck and the collar tips |
| `seam` | Rows `[top, bottom]` across the neck and collar. The footage is solid from `top` (it fades in over a hair's width above). The live video fades out over the first half of that band, over solid footage, so there is no dip and no cut, and the two necklines never show together |
| `matte` | Required. A PNG the size of `still`, with the head as opaque pixels and the backdrop transparent. The live video and the still are cut out with it, so the head sits on any scene |
| `packed` | Required, `true`. Each clip video is twice the frame height: the picture on top, its alpha matte (gray) below. A WebGL canvas draws them with real alpha, so edges are smooth. Without WebGL the page falls back to the SVG robot |
| `tracked` | Optional. Each clip has `<name>.track.json`: `{ "fps": 24, "frames": [[dx, dy, rotation], ...] }`. The live head moves with the neck on every frame (shift as a fraction of the frame width, tilt in radians, clockwise positive). Without it the head stays still while the body sways |
| `fit` | Optional. Sizes and places the live head on the footage body: `scale` about the neck (0.5 to 1.5, default 1), then `dx` and `dy` as fractions of the frame width (each within 0.1). Match the neck and face width of the footage |
| `mirror` | Optional, `true` to draw the whole figure, live head included, as a mirror image. `fit` stays as authored for the unflipped figure. Use it when the footage gestures away from the scene panel (the panel sits to her right). Build with `--mirror` |
| `floor` | Optional. Where the soles are (`y`, fraction of the frame height) and how wide the feet stand (`width`, fraction of the frame width). Draws a soft contact shadow there, so she stands on the scene instead of floating |
| `still` | Optional. The avatar's first frame, cropped like the live video. Shown until a session is live |
| `idle` | A clip that loops forever |
| `joins` | Optional. The file `scripts/analyze-showroom-body.mjs` writes: per gesture, the frames that match an idle pose. Without it gestures start at once and cross-fade, which shows as a cut |
| `clips` | Gesture name to file name. `present` can have `-right`, `-up` and `-down` variants. A missing gesture is skipped |

Rules for your clips:

- Film on a green screen. The build script makes the alpha matte and packs it under the picture, so there is no alpha channel in the file (Safari has none in WebM).
- The head area is transparent in every clip (the build script erases it). The live video draws the face.
- Line up the collar: the collar tips in the live video must sit where the collar is in the footage.
- Make the matte from the avatar's first frame (the `still`) with any background remover. Keep hair and ears, drop the backdrop.
- Each gesture clip shows the whole body and ends in the idle pose.
- Names the app uses: `wave`, `present`, `beat`, `beat2`, `celebrate`, `shrug`. Keep arms away from the head: the head area is erased, so a hand near the face looks cut off. A missing gesture is skipped.

If the folder cannot load, the page falls back to the SVG robot.

### Make a body from green-screen footage

Put `idle.mp4` and one mp4 per gesture (`wave.mp4`, `present-right.mp4`, `beat.mp4`, ...) in a folder, then run:

```bash
node scripts/build-showroom-body.mjs <raw-folder> examples/showroom/bodies/<name> \
  --head=left,top,width,height --seam=top,bottom --blank=left,right --still=<first-frame.jpg> --matte=<mask.png>
```

`--matte` takes a gray image the size of the still: white where the head is, black elsewhere. The script erodes and softens it a little and writes `head-matte.png`.

The script keys green into an alpha matte (and removes green spill), follows the collar on every frame and writes the neck track, erases the head (the columns in `--blank`, above the `--seam` rows, with soft edges, so raised hands stay; the hole moves with the track), loops the idle clip forward and back, trims each gesture to its moving part, packs matte under picture, encodes both formats and writes `manifest.json`. Extra flags: `--windows=clip:start-end,...`, `--fit=scale,dx,dy` and `--floor=y,width` (see `fit` and `floor`), `--width=1080` (frame width, default 720), `--crf-vp9=30`, `--crf-h264=21` (lower is sharper and larger). It needs `ffmpeg` on the path and takes several minutes. Open `?body=<name>` to try it.

### Find the seamless joins

The build runs this at the end. Run it again by hand after you change a clip:

```bash
node scripts/analyze-showroom-body.mjs examples/showroom/bodies/<name>
```

It compares every clip frame with every idle frame and writes `joins.json` (about 20 KB). A distance of 3 or less is invisible, about 6 is mild, 10 or more shows as a ghost. It prints the median start distance and the last-frame distance per clip. The phone-size copy reuses the file, because its frame counts are the same.

### Make a phone-size copy

```bash
node scripts/shrink-showroom-body.mjs examples/showroom/bodies/<name> examples/showroom/bodies/<name>-lite
```

This rescales every clip to 720 px wide (`--width`, `--crf-vp9`, `--crf-h264` to tune) and copies the tracks, still and matte. The page loads `<name>-lite` first on screens under 600 px wide, and falls back to `<name>` if the folder is missing. The default `guide-lite` is about 4 MB in WebM and 5 MB in MP4, against 11 MB and 18 MB for `guide`.

## Test

| Command | Covers |
|---|---|
| `npm test` | Reducer, tools, layout, rig math, gesture layers and director, bridge, agent spec, source rules |
| `npm run verify:showroom` | Chromium, Firefox and WebKit through Playwright: every scene, 5 viewport sizes, touch targets, axe, reduced motion, kiosk, voice and touch parity, follow-up chips, start retry and the joining and failed states, the clip body (phone-size copy on narrow screens), the light theme (axe contrast on every scene), and a frame-time budget (median p95 of three 3 s windows under 40 ms, ready under 3 s, at most 2 long tasks). Run `npx playwright install` once first. Pass `-- --browsers=chromium` or `-- --shots=<dir>` |
| `node --env-file=<env> scripts/live-showroom-voice.mjs` | Needs credentials and a provisioned agent. Plays a recorded sentence (made with macOS `say` and `ffmpeg`, or pass `--wav=<file>`) through a fake microphone in Chromium, Firefox and WebKit. Passes when the agent opens the device screen, the chips appear with no tap, and the neck seam shows no cut in 12 screenshots. Add `--shots=<dir>` to save the page and the raw avatar frame, and `--size=1080x1920` to pick the window size |

# Showroom experiment report: a faked full-body avatar

Closed on 2026-11-06. This branch is kept for reference. It is not meant to merge.

## Question

Can an avatar get a full body without rendering a full body in the avatar video? The idea was cheaper than a full-body render: pre-made body clips, with the live avatar head placed on the neck.

## Answer

No, not reliably. The seams can be made almost invisible in numbers, but people still see flicker, stiff gestures and a body that does not belong to the voice. The avatar video renders the head and upper frame only today. A believable full body needs full-body rendering in the avatar video itself.

## What was built

| Part | Where | Notes |
|---|---|---|
| Store app "Gizmo Grove", rep "Juno" | `index.html`, `js/`, `styles/` | Voice and touch on one screen. Phone, tablet and kiosk layouts, light and dark. |
| Agent | `agent/` | `provision.mjs` creates the avatar, tools and agent on the test account. The ids it writes go to a gitignored `agent.json`. |
| Voice and touch bridge | `js/bridge.js` | Tool calls change the store. Taps change the store and send a short note to the agent. Store state goes back as request variables. |
| Body rig | `js/rig/clip-body.js`, `layers.js`, `joins.js`, `director.js` | Described below. |
| Body footage | `bodies/guide/` (1080 wide), `bodies/guide-lite/` (720 wide) | 7 clips each: `idle`, `wave`, `present-right`, `beat`, `beat2`, `celebrate`, `shrug`. AI-generated green-screen video. |
| Build and analysis | `scripts/build-showroom-body.mjs`, `analyze-showroom-body.mjs`, `shrink-showroom-body.mjs`, `scripts/lib/body-track.mjs` | Keys the footage, packs it, tracks the neck, finds join frames. |
| Checks | `scripts/verify-showroom.mjs`, `scripts/live-showroom-voice.mjs`, `test/unit/showroom-*.test.js` | Layout and behaviour in three browsers. A live voice run with a fake microphone. |

### How the body rig works

- Each clip video is packed 1080x3840: the picture on top, its alpha matte below. A WebGL canvas draws the idle loop and up to two gesture clips with weights that add up to 1.
- The head is erased from every clip. The live avatar video is drawn into a 2D canvas through `head-matte.png` and placed on the neck. Each clip has a `.track.json` with the neck position and tilt per frame, so the head follows the body.
- A gesture clip loads into the slot that is not showing and keeps the old frame on screen until the new clip has a frame.
- `joins.json` holds, for every idle frame, the clip frame that looks most like it, and for every clip, the frames that look like an idle pose. A gesture starts when the idle loop reaches a matching pose, and hands back at a matching pose. A distance of 3 or less is invisible, about 6 is mild, 10 or more shows as a ghost.
- The director picks gestures while she talks (never the same one twice, an open hand after a question), adds nods and tilts, and drifts the idle rate.

## What went wrong, in order

| Symptom | Cause | Change | Result |
|---|---|---|---|
| Stuck on "connecting", no clear start | The page connected before the visitor acted | A "Meet Juno" tap starts the session, mic permission and retry are explicit | Fixed |
| Double neck, hair looked cut | Head and body were two sources with no shared motion | Head erased from the clips, head matte, seam fade, neck tracks, better portrait for the avatar face | Much better, never perfect |
| Rare flicker of the whole figure | A gesture slot went blank while the next one loaded | Two gesture slots. The old frame stays until the new one has a frame | Fixed in tests |
| Repetitive, canned gestures | One gesture on a fixed beat | Director with weighted picks, nods, tilts, rate drift | Better, still canned |
| Poses fade like an edited video | A cross-fade between unrelated poses | Pose-matched joins, a state machine that waits for a matching pose and seeks the idle loop before handing back | Frame steps at joins 4 to 8.6, inside-gesture median 4 to 10. Seamless in numbers |
| "Too wide, too mechanical, flickers between poses, awkward" | See the causes below | Slower gestures with eased speed, rarer gestures, smaller and softer nods and tilts | Not accepted by the visitor testing it |

## Measurements

| Check | Result |
|---|---|
| Live voice run, 3 browsers at 5 sizes (phone to 2160x3840 kiosk), fake microphone | Passed. The neck seam stayed at 0.7x to 2.7x the even-fade step (limit 6) |
| Layout and behaviour suite (`verify-showroom`) in Chromium, Firefox and WebKit | Passed |
| WebKit frame times | p50 17 ms, p95 20 ms, no long tasks |
| Real Chrome with GPU, a 70 s speaking session | Figure area dipped to about 96.5% only while a gesture was on (the arm changes the silhouette). 1 slow frame in 4194 |
| Firefox connection | 2 ICE failures in about 15 live runs, both passed on rerun. Cause not found. Not tied to the rig |

A last check found large frame-to-frame changes while no gesture was flagged. It was cut short and the cause is not known.

The numbers were good and a person still called the result awful. They measure pixel continuity. People judge whether the motion is plausible.

## Why it does not work

1. **Body and voice are not coupled.** The body clip does not know what she says. Real gestures land on stressed words and the head leads or follows the hand. Random timing reads as canned.
2. **The footage moves only the forearm.** The shoulders, torso and weight stay still. Bigger gestures would look worse: the visitor's complaint was movement that is too wide and too mechanical, not too small. The space between "dead" and "too much" was empty.
3. **Joins hide cuts, not motion.** Waiting for a matching pose delays a gesture by up to about a second. Holding the idle loop on a pose through the fade makes the body look stiff.
4. **Two sources of truth at the neck.** Any mismatch between the neck track and the live head shows as a seam, a double neck or a cut in the hair.
5. **Every gesture is a separate AI take.** Light, colour and identity drift between takes. Matching them is fragile, and each new gesture costs generation credits, a build and an analysis run.

## What is reusable

| Reusable | Where |
|---|---|
| Store, scenes, tools, voice and touch bridge, suggested-question chips, kiosk reset, captions, mute | `js/` (all except `js/rig/`) |
| Agent provisioning on the test account | `agent/provision.mjs`, `agent/spec.mjs` |
| Live voice run with a fake microphone (swaps `getUserMedia` for a WebAudio stream) | `scripts/live-showroom-voice.mjs` |
| Multi-browser, multi-size layout suite | `scripts/verify-showroom.mjs` |
| Packed colour-over-matte video drawn with WebGL, frame-exact uploads | `js/rig/clip-body.js` |

A full-body avatar video would make `js/rig/`, `bodies/` and the body build scripts unnecessary. The rest would stay.

## Testing notes

- Headless Chromium uses a software GL. Reading a WebGL canvas needs `preserveDrawingBuffer: true`, injected with an init script.
- A video that is paused shows the frame at `currentTime`. A playing one reports frames through `requestVideoFrameCallback`. The rig uses both.
- A CSS mask on the live head made Firefox repaint every frame and drop to 30 fps. The head is cut out in a canvas instead.
- Some browsers load nothing for a paused video. Playing it for a moment gets the first frame.
- Filmstrips (a few frames per second of a clip) were the fastest way to judge a join. Frame-step distance does not replace watching it.

## Not done

- No new gesture clips: the visitor asked for smaller movement, not bigger, and more footage would not fix the coupling.
- No outside review and no comparison with other products.
- No live call tested by a person beyond the visitor's own tries.

## Run it

See the [README](README.md). `node scripts/verify-showroom.mjs` runs the layout and behaviour suite in three browsers. `scripts/live-showroom-voice.mjs` runs the live voice check.

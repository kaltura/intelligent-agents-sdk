# Recipe — Pause the Avatar for Video/Interactive Content, Then Resume

How to pause a live avatar conversation while you show a video, quiz, or any other on-screen
content, then hand the turn back to the avatar cleanly — covering both the happy path (content
plays to completion) and the case where it's skipped or never finishes (don't leave the avatar
stuck paused). Built entirely from two existing `KalturaAvatarSession` methods — no new SDK
surface, no server-side glue.

---

## The mechanism

Two methods on a connected `KalturaAvatarSession` (see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md)'s
`pauseConversation`/`resumeConversation` for the wire shape):

```js
session.pause();          // sync — stops the turn loop
await session.resume();   // async — hands the turn loop back
```

**`pause()`** sets `session.paused = true` and tells the server to stop the turn loop
(`pauseConversation`). It's synchronous — there's nothing to await. Live-verified: a `speak()`
call made while paused is accepted client-side (no throw) but the server produces no reply — the
brain simply doesn't respond until you resume. Don't drive the avatar with `speak()`/ASR while
your content is on screen; that's on your app, the SDK doesn't block it for you.

**`resume()`** always sets `session.paused = false` immediately, then takes one of two paths
depending on how long you were paused:

- **Short pause (the common case):** the server still has your session held open. `resume()`
  just emits `resumeConversation` and returns — cheap, near-instant (live-verified: resolved in
  ~1ms in a real session).
- **Long pause (the server released the session):** if the pause window expired before you
  called `resume()`, the server already tore down your STV/ASR transports and told the SDK so
  (`pauseSessionExpired` / `sessionReadyForResume` — see below). `resume()` detects this
  internally and rebuilds the ASR (and, in video mode, STV) transports against a fresh session
  before handing the turn loop back — the same connect machinery `connect()` itself uses. This
  path takes as long as a fresh media (re)negotiation, not the ~1ms of the short path.

**You never need to branch on which path it takes.** Always just `await session.resume()` — it
picks the right one for you. The exact length of the pause window before the server releases the
session isn't a published constant; don't rely on an exact number, and always resume via one of
the triggers below rather than assuming a pause lasts as long as you need it to.

**Calling `resume()` is safe in the cases that matter for this recipe** — live-verified immediately
after `pause()` (zero delay), when the session was never paused, and when it was already resumed.
In each of those, it returns cleanly with `session.paused === false` and never throws or hangs,
which is why the edge-case handling below is just "call `resume()` from every exit path,
unconditionally," for any pause in the seconds-to-low-minutes range this recipe is meant for.

**One case where it isn't safe, live-verified:** pause for long enough (several minutes, well past
your content ever needing to run) and the SDK's own connectivity recovery can step in *before* your
app calls `resume()` — a stalled/expired media channel triggers an internal `_coldReconnect()` that
rebuilds the session and restores the conversation on its own, silently, without ever clearing
`session.paused` or the internal "server released this session" flag `resume()` checks. Call
`resume()` after that has already happened and it takes the "rebuild transports" branch on a
session that doesn't need rebuilding — live-verified, this made `resume()` reject after a 30s
timeout (`ASRConnectionFailed: timed out waiting for the server`) even though the conversation was
already working again by the time `resume()` was called and kept working afterward.  Practical
takeaway: keep your safety-net timeout well under the multi-minute range (the example below uses
60s, not 5 minutes) so you always resume before this can happen, and treat a `resume()` rejection
defensively — catch it, and if `session.state` is still `'connected'`, the session likely already
recovered on its own and there's nothing further to do.

You don't need to listen for any event to know resume worked — `await session.resume()`
resolving is the only signal your app needs. Two events exist for optional UX polish, but neither
is required:

| Event | When it fires | Use it for |
|---|---|---|
| `'resumed'` | The server's own `conversationResumed` ack arrives (after a `resumeConversation` you sent — from your own `resume()` call, whichever path it took) | Optional confirmation toast/log — `resume()`'s promise already told you it's done |
| `'resumeReady'` / `'timeExpired'` (`{type:'pause_expiry'}`) | The pause window expired *while you were still paused, before you called `resume()`* | Optional "still there?" UI while paused long — not required; `resume()` handles this transparently whenever you do call it |

---

## Minimal runnable example

Plain HTML/JS, no build step — matches the pattern in `examples/browser-experience.html`. Assumes
a server endpoint `/appInit` that calls `Management.application.appInit()` for you (see
[GETTING-STARTED.md](../GETTING-STARTED.md) and [API-REFERENCE.md § Initialize the
Runtime](../API-REFERENCE.md#initialize-the-runtime)).

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Pause for video, then resume</title>
</head>
<body>
  <div id="avatar"></div>

  <button id="play">▶ Show video</button>
  <div id="overlay" hidden>
    <video id="clip" src="/your-video.mp4" controls></video>
    <button id="skip">Skip</button>
  </div>

  <!-- socket.io is YOUR dependency — injected, never bundled by the SDK. -->
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js" integrity="sha384-2huaZvOR9iDzHqslqwpR87isEmrfxqyWOF7hr7BY6KG0+hVKLoEXMPUJw3ynWuhO" crossorigin="anonymous"></script>
  <script type="module">
    // Local dev: relative path into the repo. npm consumers import
    // '@kaltura/intelligent-agents/experience'; browser-only deploys pin a
    // jsDelivr tag — see README.md § Browser via jsDelivr.
    import { KalturaAvatarSession } from '../src/experience/index.js';

    const init = await fetch('/appInit').then((r) => r.json());

    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    document.getElementById('avatar').appendChild(video);

    const session = new KalturaAvatarSession({
      token: init.ks,
      conversationManagerUrl: init.conversationManagerUrl,
      srsBaseUrl: init.srsBaseUrl,
      turnServerUrl: init.turnServerUrl,
      videoEl: video,
      socketFactory: (url, opts) => io(url, opts),
    });
    await session.connect();

    const overlay = document.getElementById('overlay');
    const clip = document.getElementById('clip');

    document.getElementById('play').onclick = () => {
      // 1) Pause BEFORE the content starts — the avatar goes quiet immediately.
      session.pause();
      overlay.hidden = false;
      clip.currentTime = 0;
      clip.play();

      // 2) Resume from EVERY exit path, exactly once. resume() is safe to call
      //    more than once (or when not paused at all) — this guard just avoids
      //    a redundant resumeConversation emit, not a correctness requirement.
      let resumed = false;
      const resumeOnce = () => {
        if (resumed) return;
        resumed = true;
        overlay.hidden = true;
        session.resume().catch((e) => {
          // A rejection here almost always means the pause ran long enough that the SDK's own
          // connectivity recovery already restored the session on its own (see "The mechanism"
          // above) — check session.state before treating this as fatal.
          if (session.state !== 'connected') console.error('resume failed', e);
        });
      };

      clip.addEventListener('ended', resumeOnce, { once: true });   // happy path: content finished
      clip.addEventListener('error', resumeOnce, { once: true });   // content failed to load
      document.getElementById('skip').onclick = resumeOnce;          // user skipped it
      setTimeout(resumeOnce, 60_000);                                 // safety net: never leave the avatar stuck paused —
                                                                       // keep this well under the multi-minute range (see caveat above)
    };
  </script>
</body>
</html>
```

That's the whole recipe — one `pause()` call before the content shows, one `resume()` call wired
to every way the content can end (finished, failed, skipped, or simply taking too long). No
custom protocol handling, no state machine of your own to build.

---

## The edge case: don't leave the avatar stuck paused

The issue this recipe answers isn't "how do I pause" — `pause()` alone is trivial. It's "what if
the content never cleanly finishes." Four ways that happens, and why each is already covered
above:

| What happens | Why `resumeOnce()` still fires |
|---|---|
| Content plays to the end | `ended` |
| Content fails to load (404, codec error, network) | `error` |
| User clicks away / hits a "skip" control | your own `skip` handler |
| Content hangs, or you simply forget to wire an end event | the `setTimeout` safety net |

Whichever path fires, it calls the same `resume()`, and `resume()` handles both the cheap path and
the rebuild-transports path for you — as long as you call it within a reasonable window (seconds to
low minutes). That's why the safety-net `setTimeout` above is 60 seconds, not something open-ended:
past the multi-minute range, the SDK's own recovery may already have stepped in first, and
`resume()`'s rebuild attempt can then reject (see the caveat under "The mechanism"). Keep the
safety net short and this never comes up in practice.

---

## Related docs

| Doc | What it adds |
|---|---|
| [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) | The sibling mechanism for letting the avatar drive *your* UI (as opposed to this recipe, where *you* drive the avatar's pause state) |
| [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) | The exact `pauseConversation`/`resumeConversation`/`pauseSessionExpired`/`sessionReadyForResume`/`conversationResumed` wire shapes |
| [GETTING-STARTED.md](../GETTING-STARTED.md) | Where `/appInit` and the live avatar session come from in the first place |
| [examples/browser-experience.html](../examples/browser-experience.html) | The base live-avatar page this recipe extends |

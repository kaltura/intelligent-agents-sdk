let audioElSeq = 0;

/**
 * track-sink — routes an STV downlink's `pc.ontrack` events to the right DOM element,
 * one element per track kind, instead of dumping every track onto a single `<video>`.
 *
 * Both `KalturaAvatarSession` and `KalturaScriptedVideoSession` negotiate the STV
 * downlink with two `recvonly` transceivers (video + audio); `ontrack` fires once per
 * track. Assigning `e.streams[0]` straight onto `videoEl.srcObject` on every firing is a
 * bug: the two tracks are not guaranteed to share a `MediaStream` (they don't, in this
 * SDK's own WebRTC test double — see `test/fakes/rtc.js#fireTrack`), so whichever track's
 * event lands last silently clobbers the other's stream on the element — the dropped
 * track is never stopped or reachable again.
 *
 * `attach()` gives each track kind exclusive ownership of its own element (`videoEl` for
 * video, a lazily-created `<audio>` in `document.body` for audio) and always disposes of
 * the previous track of that kind before the new one lands — the same code path handles
 * both the initial connect and an STV re-subscribe (media recovery) without any special
 * casing at the call site.
 *
 * Zero-dependency; `doc` is injectable for tests (mirrors `wire.js`'s pure-helper style
 * and `session.js`'s own `typeof document !== 'undefined'` feature-detection). With no
 * `document` available (headless/SSR), the audio track simply isn't rendered by the SDK —
 * it's still reachable via the session's own `'track'` event for a custom consumer.
 *
 * The `<audio>` element carries a `kaltura-avatar-audio` class — same `k`-prefixed
 * marker convention as the SDK-owned nodes in `genui/renderers/dom-helpers.js`/`mount.js`
 * (`kgenui`, `kgenui__title`, …) — plus a unique `id` so it's easy to find in the DOM even
 * with several sessions on one page.
 *
 * @param {{videoEl?: any, doc?: any, mediaStreamConstructor?: typeof MediaStream}} [cfg]
 */
export function createTrackSink(cfg = {}) {
  const videoEl = cfg.videoEl || null;
  const doc = cfg.doc || (typeof document !== 'undefined' ? document : null);
  const MediaStreamCtor = cfg.mediaStreamConstructor || globalThis.MediaStream;

  let audioEl = null;
  let videoTrack = null;
  let audioTrack = null;

  /** @param {any} el */
  function playAndSwallow(el) {
    if (typeof el?.play !== 'function') return;
    try {
      const pr = el.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => { /* autoplay policies vary */ });
    } catch { /* */ }
  }

  /** @param {any} track */
  function stop(track) { try { track?.stop?.(); } catch { /* */ } }

  /**
   * @param {MediaStreamTrack} track
   * @param {readonly MediaStream[]} [streams]
   */
  function attach(track, streams) {
    if (!track) return;
    if (track.kind === 'video') {
      if (!videoEl) return;
      if (videoTrack && videoTrack !== track) stop(videoTrack);
      videoTrack = track;
      videoEl.srcObject = new MediaStreamCtor([track]);
      playAndSwallow(videoEl);
      return;
    }
    if (track.kind === 'audio') {
      if (!doc) return; // headless/no-DOM: nothing to attach to, 'track' event is still the escape hatch
      if (!audioEl) {
        audioEl = doc.createElement('audio');
        audioEl.autoplay = true;
        audioEl.className = 'kaltura-avatar-audio';
        audioEl.id = 'kaltura-avatar-audio-' + (++audioElSeq);
        doc.body.appendChild(audioEl);
      }
      if (audioTrack && audioTrack !== track) stop(audioTrack);
      audioTrack = track;
      audioEl.srcObject = new MediaStreamCtor([track]);
      playAndSwallow(audioEl);
    }
  }

  /** Stop whatever's attached, null both srcObjects, remove the audio element. Idempotent. */
  function teardown() {
    if (videoTrack) { stop(videoTrack); videoTrack = null; }
    if (videoEl) videoEl.srcObject = null;
    if (audioTrack) { stop(audioTrack); audioTrack = null; }
    if (audioEl) {
      audioEl.srcObject = null;
      try { audioEl.remove?.(); } catch { /* */ }
      audioEl = null;
    }
  }

  return {
    attach,
    teardown,
    get audioEl() { return audioEl; },
  };
}

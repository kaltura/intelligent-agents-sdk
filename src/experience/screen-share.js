/**
 * Screen share capture for {@link KalturaAvatarSession#startScreenShare}.
 *
 * Turns a display `MediaStream` into JPEG stills. One hidden `<video>` and one
 * `<canvas>` are reused for every frame, so a share does not allocate per still.
 * The session owns the timer and the socket. This module only grabs frames.
 */
import { KalturaError } from '../core/errors.js';

/** Defaults for `startScreenShare()`. `intervalMs` is the pause between stills. @type {Readonly<{intervalMs:number,maxWidth:number,quality:number}>} */
export const SCREEN_SHARE_DEFAULTS = Object.freeze({ intervalMs: 2000, maxWidth: 1500, quality: 0.5 });

/**
 * @typedef {object} StillCapturer
 * @property {() => Promise<ArrayBuffer>} grab One JPEG still of the current screen.
 * @property {() => void} close Release the hidden element.
 */

/**
 * The default capturer: a muted `<video>` plays the stream, a `<canvas>` scales and encodes each frame.
 * @param {MediaStream} stream
 * @param {{maxWidth:number, quality:number}} opts
 * @param {Document} [doc]
 * @returns {Promise<StillCapturer>}
 */
export async function createStillCapturer(stream, opts, doc = globalThis.document) {
  if (!doc?.createElement) throw unsupported('Screen share needs a browser document to draw frames.');
  const video = /** @type {HTMLVideoElement} */ (doc.createElement('video'));
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  const canvas = /** @type {HTMLCanvasElement} */ (doc.createElement('canvas'));
  return {
    async grab() {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new KalturaError({ type: 'about:blank', title: 'no frame', code: 'screen_share_capture_failed', detail: 'The shared screen has not produced a frame yet.' });
      const scale = Math.min(1, opts.maxWidth / w);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', opts.quality));
      if (!blob) throw new KalturaError({ type: 'about:blank', title: 'encode failed', code: 'screen_share_capture_failed', detail: 'The browser could not encode the frame as JPEG.' });
      return blob.arrayBuffer();
    },
    close() { video.pause(); video.srcObject = null; },
  };
}

/**
 * Map a `getDisplayMedia` rejection to an SDK error. A cancelled picker is the
 * common case, so it gets its own code.
 * @param {any} err
 */
export function screenShareError(err) {
  const name = (err && (err.name || err.constructor?.name)) || '';
  const denied = name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError';
  const code = denied ? 'screen_share_denied' : 'screen_share_failed';
  const detail = denied
    ? 'Screen sharing was cancelled or blocked. The user must pick a screen or window and allow sharing.'
    : 'The browser could not start screen sharing.';
  return new KalturaError({ type: `https://docs.kaltura.com/agentic/errors/${code}`, title: code.replace(/_/g, ' '), code, detail, body: String(err && err.message || err) });
}

/** @param {string} detail */
export function unsupported(detail) {
  return new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/screen_share_unsupported', title: 'screen share unsupported', code: 'screen_share_unsupported', detail });
}

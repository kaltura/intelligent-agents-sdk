/**
 * Pop-out: while a live video conversation is connected and the visitor leaves
 * the tab (another tab, or another app covering the window), Nova's avatar
 * floats in a small always-on-top window so she stays visible.
 *
 * Chrome and Edge open it by themselves: they call the page's media session
 * `enterpictureinpicture` handler when the tab is hidden, as long as the page
 * is capturing the mic. Where a browser never calls the handler, or has no
 * Document Picture-in-Picture, nothing happens and nothing is shown.
 *
 * Only the avatar box moves. The <audio> element and the session stay in the
 * page. The window closes by itself when the visitor comes back, and the box
 * goes home. It is only armed in a video session, so chat and a closed Nova
 * never pop out.
 */
const SIZE = { width: 340, height: 340 };

const CSS = `
  html, body { margin: 0; height: 100%; background: #171a22; overflow: hidden; }
  .nova-pip { position: relative; width: 100%; height: 100%;
    background: radial-gradient(circle at 50% 40%, #3b4a7c 0%, #171a22 78%); }
  .nova-pip .nova-avatar { position: absolute; inset: 0; }
  .nova-pip .nova-avatar :is(video, canvas) { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .nova-pip .nova-figure { display: none; }
  .nova-keyed-canvas { display: none; filter: url(#nova-feather); pointer-events: none; }
  .nova-avatar.is-keyed > .nova-keyed-canvas { display: block;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
    mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); }
  .nova-avatar.is-keyed:has(> .nova-keyed-canvas) video { visibility: hidden; }
  .nova-pip-ai { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; border-radius: 999px;
    background: rgba(0, 0, 0, 0.6); color: #fff; font: 600 12px system-ui, sans-serif; }
`;

/**
 * @param {object} cfg
 * @param {() => boolean} cfg.isLive   True while a video conversation is connected.
 * @param {Element} cfg.avatar         The avatar box (video and keyed canvas).
 * @param {Document} [cfg.doc]
 * @param {Window} [cfg.win]
 * @returns {{ arm: () => void, disarm: () => void }}
 */
export function initPopout({ isLive, avatar, doc = document, win = window }) {
  const supported = 'documentPictureInPicture' in win && !!win.navigator.mediaSession;
  let armed = false;
  let pip = null; // { win, marker } while the avatar is in the pop-out

  /** Put the avatar back where it was. Safe to call twice. */
  function restore() {
    if (!pip) return;
    const { marker } = pip;
    pip = null;
    if (marker.parentNode) marker.replaceWith(avatar);
  }

  async function open() {
    if (!armed || !isLive() || pip || win.documentPictureInPicture.window) return;
    let popup;
    try {
      popup = await win.documentPictureInPicture.requestWindow(SIZE);
    } catch {
      return; // no user activation or the browser said no: nothing to show
    }
    // The visitor may have left video while the window was opening.
    if (!armed || !isLive() || !avatar.isConnected) { popup.close(); return; }

    const style = popup.document.createElement('style');
    style.textContent = CSS;
    popup.document.head.append(style);
    popup.document.title = 'Nova';

    // The keyed canvas refers to this filter by id, so the window needs its own copy.
    const feather = doc.getElementById('nova-feather')?.closest('svg');
    if (feather) popup.document.body.append(feather.cloneNode(true));

    const root = popup.document.createElement('div');
    root.className = 'nova-pip';
    const badge = popup.document.createElement('div');
    badge.className = 'nova-pip-ai';
    badge.textContent = 'AI avatar';

    const marker = doc.createComment('nova-avatar');
    avatar.before(marker);
    pip = { win: popup, marker };
    root.append(avatar, badge);
    popup.document.body.append(root);
    popup.addEventListener('pagehide', restore, { once: true });
  }

  function arm() {
    if (!supported || armed) return;
    try {
      win.navigator.mediaSession.setActionHandler('enterpictureinpicture', open);
      armed = true;
    } catch {
      // This browser has no enterpictureinpicture action: it never pops out by itself.
    }
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    try {
      win.navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
    } catch { /* same as arm() */ }
    const popup = pip?.win;
    restore();
    popup?.close();
  }

  return { arm, disarm };
}

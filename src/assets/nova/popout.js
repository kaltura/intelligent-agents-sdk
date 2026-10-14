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
 *
 * Hovering the window shows the call controls (mic, pause, screen share). The
 * page owns what they do; this file only draws them and forwards clicks.
 */
const SIZE = { width: 340, height: 340 };

/** Material icon paths (24px), keyed by the icon names the page's own controls use. */
const ICONS = {
  mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  mic_off: 'M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  play_arrow: 'M8 5v14l11-7z',
  screen_share: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.11-.9-2-2-2H4c-1.11 0-2 .89-2 2v10c0 1.1.89 2 2 2H0v2h24v-2h-4zm-7-3.53v-2.19c-2.78 0-4.61.85-6 2.72.56-2.67 2.11-5.33 6-5.87V7l4 3.73-4 3.74z',
  stop_screen_share: 'M21.22 18.02l2 2H24v-2h-2.78zm.77-2l.01-10c0-1.11-.9-2-2-2H7.22l5.23 5.23c.18-.04.36-.07.55-.1V7.02l4 3.73-1.58 1.47 5.54 5.54c.61-.33 1.03-.99 1.03-1.74zM2.39 1.73L1.11 3l1.54 1.54c-.4.36-.65.89-.65 1.48v10c0 1.1.89 2 2 2H0v2h18.13l2.71 2.71 1.27-1.27L2.39 1.73zM7 15.02c.31-1.48.92-2.95 2.07-4.06l1.59 1.59c-1.54.38-2.7 1.18-3.66 2.47z',
};

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
  .nova-pip-bar { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 6px;
    opacity: 0; transition: opacity 0.15s; }
  .nova-pip:hover .nova-pip-bar, .nova-pip:focus-within .nova-pip-bar { opacity: 1; }
  .nova-pip-bar button { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%;
    display: grid; place-items: center; cursor: pointer; background: rgba(0, 0, 0, 0.6); color: #fff; }
  .nova-pip-bar button:hover:not(:disabled) { background: rgba(0, 0, 0, 0.8); }
  .nova-pip-bar button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .nova-pip-bar button:disabled { opacity: 0.4; cursor: default; }
  .nova-pip-bar svg { width: 22px; height: 22px; fill: currentColor; }
`;

/**
 * @param {object} cfg
 * @param {() => boolean} cfg.isLive   True while a video conversation is connected.
 * @param {Element} cfg.avatar         The avatar box (video and keyed canvas).
 * @param {Array<{ read: () => { icon: string, label: string, disabled: boolean }, click: () => void }>} [cfg.controls]
 *   Hover buttons. `icon` is a key of ICONS.
 * @param {Document} [cfg.doc]
 * @param {Window} [cfg.win]
 * @returns {{ arm: () => void, disarm: () => void, refresh: () => void }}
 */
export function initPopout({ isLive, avatar, controls = [], doc = document, win = window }) {
  const supported = 'documentPictureInPicture' in win && !!win.navigator.mediaSession;
  let armed = false;
  let pip = null; // { win, marker, buttons } while the avatar is in the pop-out

  /** Redraw the hover buttons from the page's current control state. */
  function refresh() {
    pip?.buttons.forEach((btn, i) => {
      const { icon, label, disabled } = controls[i].read();
      btn.querySelector('path').setAttribute('d', ICONS[icon] || '');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.disabled = disabled;
    });
  }

  function buildBar(popup) {
    const bar = popup.document.createElement('div');
    bar.className = 'nova-pip-bar';
    const buttons = controls.map((ctl) => {
      const btn = popup.document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path/></svg>';
      btn.addEventListener('click', () => { ctl.click(); });
      bar.append(btn);
      return btn;
    });
    return { bar, buttons };
  }

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
    const { bar, buttons } = buildBar(popup);
    pip = { win: popup, marker, buttons };
    root.append(avatar, badge, bar);
    popup.document.body.append(root);
    refresh();
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

  return { arm, disarm, refresh };
}

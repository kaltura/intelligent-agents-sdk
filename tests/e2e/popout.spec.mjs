import { test, expect } from './fixtures.mjs';

// popout.js moves Nova's avatar into a Document Picture-in-Picture window when
// the browser calls the `enterpictureinpicture` media session handler. A real
// pop-out needs a headed browser and a real tab switch, so these tests give the
// module a fake window object and an iframe as the pop-out.

/** Build the module with fakes and expose what the tests need on `window.__pip`. */
async function setup(page, { supported = true, live = true } = {}) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  await page.evaluate(async ({ supported, live }) => {
    const { initPopout } = await import('/assets/nova/popout.js');
    document.body.insertAdjacentHTML('beforeend', '<div id="t-home"><span id="t-before"></span><div id="t-avatar" class="nova-avatar"><video></video></div><span id="t-after"></span></div>');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;top:0;left:0;width:340px;height:340px;z-index:2147483647';
    document.body.append(frame);
    const state = { handler: undefined, live, closes: 0, requests: 0, hidden: [] };
    const popup = {
      document: frame.contentDocument,
      addEventListener: (type, fn) => state.hidden.push(fn),
      close: () => { state.closes += 1; state.hidden.splice(0).forEach((fn) => fn()); },
    };
    const fakeWin = {
      navigator: { mediaSession: { setActionHandler: (name, fn) => { if (name === 'enterpictureinpicture') state.handler = fn; } } },
    };
    if (supported) {
      fakeWin.documentPictureInPicture = { window: null, requestWindow: async () => { state.requests += 1; return popup; } };
    }
    const avatar = document.getElementById('t-avatar');
    state.ctl = [{ icon: 'mic', label: 'Mute', disabled: false, clicks: 0 }, { icon: 'screen_share', label: 'Share', disabled: true, clicks: 0 }];
    const controls = state.ctl.map((c) => ({ read: () => c, click: () => { c.clicks += 1; } }));
    state.popout = initPopout({ isLive: () => state.live, avatar, controls, win: fakeWin });
    window.__pip = { state, popup, avatar, frame };
  }, { supported, live });
}

const where = (page) => page.evaluate(() => {
  const { avatar, frame } = window.__pip;
  return avatar.ownerDocument === frame.contentDocument ? 'popup' : (avatar.previousElementSibling?.id === 't-before' ? 'home' : 'lost');
});

test('arm registers the handler, the handler moves the avatar, closing puts it back', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__pip.state.popout.arm());
  expect(await page.evaluate(() => typeof window.__pip.state.handler)).toBe('function');
  expect(await where(page)).toBe('home');

  await page.evaluate(() => window.__pip.state.handler());
  expect(await where(page)).toBe('popup');
  expect(await page.evaluate(() => window.__pip.frame.contentDocument.querySelector('.nova-pip-ai').textContent)).toBe('AI avatar');

  await page.evaluate(() => window.__pip.popup.close());
  expect(await where(page)).toBe('home');
  expect(await page.evaluate(() => document.getElementById('t-avatar').nextElementSibling.id)).toBe('t-after');
});

test('no pop-out when the conversation is not live', async ({ page }) => {
  await setup(page, { live: false });
  await page.evaluate(() => window.__pip.state.popout.arm());
  await page.evaluate(() => window.__pip.state.handler());
  expect(await page.evaluate(() => window.__pip.state.requests)).toBe(0);
  expect(await where(page)).toBe('home');
});

test('disarm removes the handler and brings an open pop-out home', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__pip.state.popout.arm(); return window.__pip.state.handler(); });
  expect(await where(page)).toBe('popup');
  await page.evaluate(() => window.__pip.state.popout.disarm());
  expect(await where(page)).toBe('home');
  expect(await page.evaluate(() => window.__pip.state.handler)).toBe(null);
  expect(await page.evaluate(() => window.__pip.state.closes)).toBe(1);
});

test('a session that ends while the window is opening leaves the avatar home', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const { state } = window.__pip;
    state.popout.arm();
    state.live = true;
    const open = state.handler();
    state.live = false;
    return open;
  });
  expect(await where(page)).toBe('home');
});

test('a browser without Document Picture-in-Picture registers nothing', async ({ page }) => {
  await setup(page, { supported: false });
  await page.evaluate(() => window.__pip.state.popout.arm());
  expect(await page.evaluate(() => window.__pip.state.handler)).toBeUndefined();
});

test('arm twice and disarm twice are harmless', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { const { popout } = window.__pip.state; popout.arm(); popout.arm(); popout.disarm(); popout.disarm(); });
  expect(await page.evaluate(() => window.__pip.state.handler)).toBe(null);
});

test('hover buttons mirror the page controls and forward clicks', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__pip.state.popout.arm(); return window.__pip.state.handler(); });
  const buttons = () => page.evaluate(() => [...window.__pip.frame.contentDocument.querySelectorAll('.nova-pip-bar button')]
    .map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled, d: b.querySelector('path').getAttribute('d').slice(0, 12) })));

  const first = await buttons();
  expect(first.map((b) => [b.label, b.disabled])).toEqual([['Mute', false], ['Share', true]]);

  await page.evaluate(() => {
    const { state, frame } = window.__pip;
    frame.contentDocument.querySelector('.nova-pip-bar button').click();
    Object.assign(state.ctl[0], { icon: 'mic_off', label: 'Unmute' });
    Object.assign(state.ctl[1], { disabled: false });
    state.popout.refresh();
  });
  const after = await buttons();
  expect(after.map((b) => [b.label, b.disabled])).toEqual([['Unmute', false], ['Share', false]]);
  expect(after[0].d).not.toBe(first[0].d);
  expect(await page.evaluate(() => window.__pip.state.ctl.map((c) => c.clicks))).toEqual([1, 0]);
});

test('hover buttons stay hidden until the pointer is over the window', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__pip.state.popout.arm(); return window.__pip.state.handler(); });
  const opacity = () => page.evaluate(() => {
    const w = window.__pip.frame.contentWindow;
    return w.getComputedStyle(w.document.querySelector('.nova-pip-bar')).opacity;
  });
  expect(await opacity()).toBe('0');
  await page.locator('iframe').hover();
  await expect.poll(opacity).toBe('1');
});

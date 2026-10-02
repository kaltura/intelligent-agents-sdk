import { test, expect } from './fixtures.mjs';

// Static contract for the chat-mode UI (connect.js wires these at runtime;
// a live session can't run in CI, so this pins the markup and at-rest state
// the script depends on): the mode toggle exists but is hidden until a
// session connects (the #nova-mode:disabled { display:none } pattern), the
// text input row is always present, and the "chat without video" entry point
// is visible over the hero placeholder before any session starts.

test('nova widget ships the chat-mode controls in their at-rest state', async ({ page }) => {
  await page.goto('/');

  const mode = page.locator('#nova-mode');
  await expect(mode).toBeHidden();          // disabled → display:none until connected
  await expect(mode).toBeDisabled();

  await expect(page.locator('#nova-input-row')).toBeVisible();
  await expect(page.locator('#nova-input')).toBeEditable();
  await expect(page.locator('#nova-send')).toBeVisible();

  await expect(page.locator('#nova-chat-start')).toBeVisible();
  await expect(page.locator('#nova-placeholder')).toBeVisible();

  // Mute/end keep their pre-session hidden state alongside the new toggle.
  await expect(page.locator('#nova-mute')).toBeHidden();
  await expect(page.locator('#nova-end')).toBeHidden();
});

test('chat-start affordance is a sibling of the placeholder, not nested in it', async ({ page }) => {
  await page.goto('/');
  // role="button" with nested interactive children breaks the accessible
  // name — regression-pin the flat structure.
  const nested = await page.locator('#nova-placeholder #nova-chat-start').count();
  expect(nested).toBe(0);
  const wrapped = await page.locator('#nova-video-wrap > #nova-chat-start').count();
  expect(wrapped).toBe(1);
});

// On any page without the hero slot, initDock() renders the widget as the
// small docked circle at rest (see dock.js). The hero's "chat without video"
// pill has no room there (it's crushed into the mic-icon circle) — this
// badge is the docked bubble's only other entry point, so it must be visible
// pre-session and gone once one starts.
test('docked bubble (no hero slot) shows the chat-without-video badge pre-session', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  const dockChat = page.locator('#nova-dock-chat');
  await expect(dockChat).toBeVisible();
  await expect(dockChat).toBeEnabled();
  // The widget's own expand-toggle listener skips clicks on any .nova-btn —
  // regression-pin that this badge is one, so clicking it doesn't also pop
  // the dock flyout open underneath the chat drawer it's about to start.
  await expect(dockChat).toHaveClass(/nova-btn/);
});

// Every entry point waits for connect.js to load the SDK (html.nova-ready).
// Before that a pill click did nothing and a typed line reloaded the page.
test('entry points stay hidden until the SDK has loaded', async ({ page }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/gh\/kaltura\/intelligent-agents-sdk@/, async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const entryPoints = ['.nova-hero-prompts', '#nova-placeholder', '#nova-chat-start', '#nova-input-row'];
  for (const sel of entryPoints) await expect(page.locator(sel)).toBeHidden();

  release();
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  for (const sel of entryPoints) await expect(page.locator(sel)).toBeVisible();
});

// A pill shows its question in the transcript on click, not when the server
// sends its copy back (that copy lands after Nova's answer in video mode).
// The click handler is delegated, so pills in a home page the router swapped
// in work too. socket.io is held, then failed, so no attempt reaches a backend.
// A failed attempt drops its bubble, so a retry doesn't glue onto it.
test('a pill on a router-swapped home page shows its question right away', async ({ page }) => {
  const held = [];
  await page.route(/^https:\/\/cdn\.socket\.io\//, (route) => { held.push(route); });
  const failHeld = async () => {
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await held.shift().abort();
  };
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  await page.locator('a[href$="/getting-started/"]').first().click();
  await expect(page).toHaveURL(/\/getting-started\/$/);
  await page.locator('a.logo').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.nova-chip').first()).toBeVisible();

  const you = page.locator('#nova-transcript .nova-you .nova-msg');
  for (const chip of [page.locator('.nova-chip').nth(0), page.locator('.nova-chip').nth(1)]) {
    const question = await chip.getAttribute('data-prompt');
    // After a failed attempt the hero swaps the pills for the status card, so click in the DOM.
    await chip.evaluate((el) => el.click());
    await expect(you).toHaveText([question]);
    await failHeld();
    await expect(page.locator('#nova-status')).toContainText('Could not connect');
    await expect(you).toHaveCount(0);
  }
});

// On a phone the chat drawer is a full sheet: it must behave as a modal
// dialog, with the page behind it inert, and hand focus back on close.
test('mobile chat sheet is a modal dialog and inerts the page behind it', async ({ page }) => {
  await page.route(/^https:\/\/cdn\.socket\.io\//, (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/getting-started/');
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  await page.locator('#nova-dock-chat').click();

  const widget = page.locator('#nova-widget');
  await expect(widget).toHaveClass(/drawer-mode/);
  await expect(widget).toHaveAttribute('role', 'dialog');
  await expect(widget).toHaveAttribute('aria-modal', 'true');
  for (const sel of ['.site-header', '#sidebar', 'main.content-wrapper']) {
    await expect(page.locator(sel)).toHaveAttribute('inert', '');
  }
  await expect(page.locator('.nova-suggest')).toBeVisible();

  await page.locator('#nova-close').click();
  await expect(widget).not.toHaveClass(/drawer-mode/);
  await expect(page.locator('main.content-wrapper')).not.toHaveAttribute('inert', '');
});

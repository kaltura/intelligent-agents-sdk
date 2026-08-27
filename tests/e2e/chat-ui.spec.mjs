import { test, expect } from '@playwright/test';

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

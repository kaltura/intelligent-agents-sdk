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

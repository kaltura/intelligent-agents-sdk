import { test, expect } from './fixtures.mjs';

test('fenced code blocks render Prism token spans', async ({ page }) => {
  await page.goto('/getting-started/');
  const tokenCount = await page.locator('main.content-wrapper pre code span.token').count();
  expect(tokenCount).toBeGreaterThan(0);
});

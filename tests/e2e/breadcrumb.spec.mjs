import { test, expect } from './fixtures.mjs';

test('a page hidden from the sidebar shows a breadcrumb back to its hub and a sibling link', async ({ page }) => {
  await page.goto('/reference/genui/analytics/');
  const breadcrumb = page.locator('.breadcrumb');
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb.getByRole('link', { name: 'GenUI Reference' })).toHaveAttribute('href', '/reference/genui-reference/');
  const siblingLink = page.locator('.sidebar a[href="/reference/genui/widgets/"]');
  await expect(siblingLink).toBeVisible();
});

test('a normal sidebar page shows no breadcrumb', async ({ page }) => {
  await page.goto('/getting-started/');
  await expect(page.locator('.breadcrumb')).toHaveCount(0);
});

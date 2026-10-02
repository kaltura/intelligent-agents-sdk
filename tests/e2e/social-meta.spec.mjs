import { test, expect } from './fixtures.mjs';

// Link previews: Open Graph and Twitter tags must use absolute https URLs,
// and the share image must exist at the size the tags declare.

const meta = (page, attr, key) => page.locator(`meta[${attr}="${key}"]`).getAttribute('content');

for (const path of ['/', '/getting-started/']) {
  test(`${path} has absolute Open Graph and Twitter tags`, async ({ page, request }) => {
    await page.goto(path);
    const image = await meta(page, 'property', 'og:image');
    expect(image).toMatch(/^https:\/\/kaltura\.github\.io\/intelligent-agents-sdk\/assets\/img\/og-card\.jpg$/);
    expect(await meta(page, 'name', 'twitter:image')).toBe(image);
    expect(await meta(page, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(await meta(page, 'property', 'og:url')).toBe(
      `https://kaltura.github.io/intelligent-agents-sdk${path}`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href',
      `https://kaltura.github.io/intelligent-agents-sdk${path}`);
    for (const key of ['og:title', 'og:description', 'og:image:alt']) {
      expect((await meta(page, 'property', key)).length).toBeGreaterThan(10);
    }
    // The absolute URL points at production, so fetch the local copy of the file.
    const res = await request.get(new URL(image).pathname.replace('/intelligent-agents-sdk', ''));
    expect(res.status()).toBe(200);
    const bytes = await res.body();
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // JPEG signature
  });
}

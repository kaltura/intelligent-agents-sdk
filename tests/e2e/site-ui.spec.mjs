import { test, expect } from './fixtures.mjs';

// Docs-site chrome from assets/site/ui.js and search.js: search dialog, code
// copy, heading anchors, mobile nav, "On this page" rail, pager, edit link,
// and a no-horizontal-overflow check across viewports.

const DOC = '/getting-started/';

test.describe('search', () => {
  test('Ctrl+K opens the dialog, ranks results, and Esc closes it', async ({ page }) => {
    await page.goto(DOC);
    await page.keyboard.press('Control+k');
    const dialog = page.locator('#searchDialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#searchInput')).toBeFocused();

    await page.locator('#searchInput').fill('pause resume');
    const hits = page.locator('#searchResults a');
    await expect(hits.first()).toBeVisible();
    await expect(hits.first().locator('mark').first()).toBeVisible();
    await expect(hits.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(hits.nth(1)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Enter follows the selected result', async ({ page }) => {
    await page.goto(DOC);
    await page.locator('#searchTrigger').click();
    await page.locator('#searchInput').fill('voice input modes');
    const first = page.locator('#searchResults a').first();
    await expect(first).toBeVisible();
    const href = await first.getAttribute('href');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${href.split('#')[0].replace(/\//g, '\\/')}`));
  });

  test('a code identifier is findable and shown as "Mentions"', async ({ page }) => {
    await page.goto(DOC);
    await page.locator('#searchTrigger').click();
    await page.locator('#searchInput').fill('createWidgetToken');
    await expect(page.locator('#searchResults a').first()).toBeVisible();
    await expect(page.locator('#searchResults .search-hit-snippet').first()).toContainText('createWidgetToken');
  });

  test('"Ask Nova" hands the query to Nova as a nova:ask event', async ({ page }) => {
    await page.goto(DOC);
    await page.evaluate(() => {
      window.__asked = null;
      document.addEventListener('nova:ask', (e) => { window.__asked = e.detail; });
    });
    await page.locator('#searchTrigger').click();
    await page.locator('#searchInput').fill('zzqq no such thing');
    await expect(page.locator('.search-empty')).toBeVisible();
    const ask = page.locator('#searchAsk');
    await expect(ask).toBeVisible();
    await ask.click();
    const asked = await page.evaluate(() => window.__asked);
    expect(asked.prompt).toContain('zzqq no such thing');
  });
});

test('code blocks get a copy button that copies the code', async ({ page, context, browserName }) => {
  // Only Chromium lets a test grant and read the clipboard.
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(DOC);
  const block = page.locator('.code-block').first();
  await expect(block).toBeVisible();
  await block.hover();
  const btn = block.locator('.code-copy');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'copied');
  if (browserName !== 'chromium') return;
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const shown = await block.locator('pre').innerText();
  expect(copied.trim()).toBe(shown.trim());
});

test('h2 headings carry a deep-link anchor', async ({ page }) => {
  await page.goto(DOC);
  const h2 = page.locator('main h2[id]').first();
  const anchor = h2.locator('.heading-anchor');
  await expect(anchor).toHaveAttribute('href', `#${await h2.getAttribute('id')}`);
});

test('tables scroll inside their own wrapper', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  const wrapped = await page.locator('main table').evaluateAll((ts) => ts.every((t) => t.parentElement.classList.contains('table-wrap')));
  expect(wrapped).toBe(true);
});

test.describe('mobile nav', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('menu button opens the drawer; backdrop, Esc and a link tap close it', async ({ page }) => {
    await page.goto(DOC);
    const sidebar = page.locator('#sidebar');
    const toggle = page.locator('#menuToggle');
    await expect(sidebar).toBeHidden();

    await toggle.click();
    await expect(sidebar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#navBackdrop')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await page.locator('#navBackdrop').click({ position: { x: 370, y: 300 } });
    await expect(sidebar).toBeHidden();

    await toggle.click();
    await sidebar.locator('a[href$="/start-the-conversation/"], a[href*="guides"]').first().click();
    await expect(sidebar).toBeHidden();
  });

  test('on the home page she zooms into the corner dock when the page scrolls', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const wrap = page.locator('#nova-video-wrap');
    const before = await wrap.boundingBox();
    expect(before.width).toBeGreaterThan(200);
    await page.mouse.wheel(0, 900);
    await expect(page.locator('#nova-widget')).toHaveClass(/dock-mode/);
    const after = await wrap.boundingBox();
    expect(after.width).toBeLessThanOrEqual(130);
    expect(after.y + after.height).toBeLessThanOrEqual(844);
    expect(after.y).toBeGreaterThanOrEqual(0);
    // Scrolling back up restores the hero card.
    await page.mouse.wheel(0, -2000);
    await expect(page.locator('#nova-widget')).not.toHaveClass(/dock-mode/);
    expect((await wrap.boundingBox()).width).toBeGreaterThan(200);
  });

  test('docked Nova is the small mobile size', async ({ page }) => {
    await page.goto(DOC);
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const box = await page.locator('#nova-video-wrap').boundingBox();
    expect(box.width).toBeLessThanOrEqual(130);
    expect(box.width).toBeGreaterThanOrEqual(100);
  });
});

test.describe('hero stage', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('idle: copy card, portrait, pills and message box share one stage', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const slot = await page.locator('#nova-hero-slot').boundingBox();
    const hero = await page.locator('.nova-hero').boundingBox();
    expect(Math.abs(slot.width - hero.width)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await page.locator('#nova-widget').boundingBox()).width - slot.width)).toBeLessThan(2);

    const card = await page.locator('.nova-hero-card').boundingBox();
    const video = await page.locator('#nova-video').boundingBox();
    const input = await page.locator('#nova-input-row').boundingBox();
    expect(card.x + card.width).toBeLessThanOrEqual(video.x);
    expect(video.y + video.height).toBeLessThanOrEqual(input.y);
    await expect(page.locator('.nova-hero-prompts .nova-chip').first()).toBeVisible();
    await expect(page.locator('#nova-placeholder')).toBeVisible();
  });

  test('live: the conversation card replaces the copy card, beside her', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    // Fake a connected call: the real one needs a live backend.
    await page.evaluate(async () => {
      document.documentElement.classList.add('nova-live');
      document.getElementById('nova-placeholder').classList.add('hidden');
      document.getElementById('nova-chat-start').classList.add('hidden');
      const t = await import('/assets/nova/transcript.js');
      t.initTranscript(document.getElementById('nova-transcript'));
      t.appendTranscript('nova', 'Hi! What are you looking to build today?');
    });
    await expect(page.locator('.nova-hero-card')).toHaveCSS('visibility', 'hidden');
    const video = await page.locator('#nova-video').boundingBox();
    const convo = await page.locator('.nova-convo').boundingBox();
    expect(convo.x + convo.width).toBeLessThanOrEqual(video.x);
    for (const sel of ['.nova-controls', '#nova-transcript']) {
      await expect(page.locator(sel)).toBeVisible();
      const box = await page.locator(sel).boundingBox();
      expect(box.x + box.width, sel).toBeLessThanOrEqual(video.x);
    }
    await expect(page.locator('#nova-input-row')).toBeVisible();
  });
});

test.describe('on this page rail', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows on doc pages, follows the scroll, and is swapped on soft navigation', async ({ page }) => {
    await page.goto(DOC);
    const toc = page.locator('.page-toc');
    await expect(toc).toBeVisible();
    const links = toc.locator('a');
    expect(await links.count()).toBeGreaterThan(2);

    const mid = links.nth(2);
    const id = (await mid.getAttribute('href')).slice(1);
    await page.evaluate((i) => document.getElementById(i).scrollIntoView(), id);
    await expect(mid).toHaveAttribute('aria-current', 'true');

    // The last section is marked once the page is scrolled to the bottom.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(links.last()).toHaveAttribute('aria-current', 'true');

    const before = await links.allInnerTexts();
    await page.locator('#sidebar a[href$="/reference/api-reference/"]').first().click();
    await expect(page).toHaveURL(/api-reference\/$/);
    await expect.poll(async () => (await page.locator('.page-toc a').allInnerTexts()).join('|')).not.toBe(before.join('|'));
  });

  test('is hidden on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.page-toc')).toBeHidden();
  });

  test('is hidden below 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(DOC);
    await expect(page.locator('.page-toc')).toBeHidden();
  });
});

test('pager links to neighbours and the edit link points at GitHub', async ({ page }) => {
  await page.goto(DOC);
  const next = page.locator('.pager-next');
  await expect(next).toBeVisible();
  const href = await next.getAttribute('href');
  await next.click();
  await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, '\\/')}$`));
  await expect(page.locator('.pager-prev')).toBeVisible();
  await expect(page.locator('.page-meta a')).toHaveAttribute('href', /^https:\/\/github\.com\/kaltura\/intelligent-agents-sdk\/edit\//);
});

test('skip link jumps to the main content', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Safari does not Tab to links by default');
  await page.goto(DOC);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('/llms.txt lists the docs pages', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.ok()).toBe(true);
  const body = await res.text();
  expect(body).toContain('/getting-started/');
});

for (const width of [390, 768, 1024, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', DOC, '/reference/api-reference/']) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveClass(/nova-ready/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
}

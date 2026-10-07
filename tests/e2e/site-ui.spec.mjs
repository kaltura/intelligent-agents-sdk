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

  test('idle: copy, chips and message box sit left of her, inside one stage', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const slot = await page.locator('#nova-hero-slot').boundingBox();
    const hero = await page.locator('.nova-hero').boundingBox();
    expect(Math.abs(slot.width - hero.width)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await page.locator('#nova-widget').boundingBox()).width - slot.width)).toBeLessThan(2);

    const copy = await page.locator('.nova-hero-card').boundingBox();
    const avatar = await page.locator('#nova-avatar').boundingBox();
    const input = await page.locator('#nova-input-row').boundingBox();
    const chips = await page.locator('.nova-hero-prompts').boundingBox();
    // The copy column ends before the middle of her box; the chips sit above the message box.
    expect(copy.x + copy.width).toBeLessThanOrEqual(avatar.x + avatar.width / 2);
    expect(chips.y + chips.height).toBeLessThanOrEqual(input.y);
    expect(input.x + input.width).toBeLessThanOrEqual(avatar.x + avatar.width / 2);
    // She stands on the bottom edge of the stage.
    expect(Math.abs(avatar.y + avatar.height - (hero.y + hero.height))).toBeLessThan(2);
    await expect(page.locator('.nova-hero-prompts .nova-chip').first()).toBeVisible();
    await expect(page.locator('#nova-placeholder')).toBeVisible();
  });

  test('live: the conversation card replaces the copy, above the message box', async ({ page }) => {
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
    await expect(page.locator('.nova-hero-copy')).toHaveCSS('visibility', 'hidden');
    const avatar = await page.locator('#nova-avatar').boundingBox();
    const convo = await page.locator('.nova-convo').boundingBox();
    const input = await page.locator('#nova-input-row').boundingBox();
    expect(convo.x + convo.width).toBeLessThanOrEqual(avatar.x + avatar.width / 2);
    expect(convo.y + convo.height).toBeLessThanOrEqual(input.y);
    for (const sel of ['.nova-drawer-head', '#nova-transcript']) {
      await expect(page.locator(sel)).toBeVisible();
      const box = await page.locator(sel).boundingBox();
      expect(box.x + box.width, sel).toBeLessThanOrEqual(avatar.x + avatar.width / 2);
    }
    await expect(page.locator('#nova-input-row')).toBeVisible();
  });

  test('idle: her full-length cutout shows; a call pushes in to the tight framing', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const figure = page.locator('.nova-figure');
    await expect(figure).toBeVisible();
    await expect(figure).toHaveCSS('opacity', '1');
    // The stream is hidden until a call starts.
    await expect(page.locator('#nova-video')).toHaveCSS('opacity', '0');
    const idle = await figure.evaluate((el) => getComputedStyle(el).transform);
    expect(idle).toBe('matrix(1, 0, 0, 1, 0, 0)');

    await page.evaluate(() => document.documentElement.classList.add('nova-live'));
    await expect.poll(() => figure.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThan(1.9);
    await expect(figure).toHaveCSS('opacity', '0');
    await expect(page.locator('#nova-video')).toHaveCSS('opacity', '1');
  });

  test('connecting and talking do not pulse her brightness', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    for (const state of ['is-connecting', 'is-talking']) {
      await page.evaluate((c) => document.getElementById('nova-video-wrap').classList.add(c), state);
      await expect(page.locator('#nova-avatar')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('#nova-video-wrap')).toHaveCSS('animation-name', state === 'is-connecting' ? 'none' : /./);
      await page.evaluate((c) => document.getElementById('nova-video-wrap').classList.remove(c), state);
    }
  });

  test('coming back to the home page after a nav puts her back in the hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const widget = page.locator('#nova-widget');
    await page.locator('#sidebar a[href$="/getting-started/"]').first().click();
    await expect(page).toHaveURL(/getting-started\/$/);
    await expect(widget).toHaveClass(/dock-mode/);

    await page.locator('#sidebar a.nav-home, #sidebar a[href$="/"]').first().click();
    await expect(page.locator('#nova-hero-slot')).toBeVisible();
    await expect(widget).not.toHaveClass(/dock-mode/);
    const slot = await page.locator('#nova-hero-slot').boundingBox();
    await expect.poll(async () => Math.abs((await widget.boundingBox()).width - slot.width)).toBeLessThan(2);
  });

  test('scroll: only her box flies to the dock, the rest of the stage fades out', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/nova-ready/);
    const widget = page.locator('#nova-widget');
    const avatar = page.locator('#nova-avatar');
    const start = await avatar.boundingBox();

    // Part way: she has moved and shrunk, the copy and message box are gone.
    // Scroll so the flight is half done (the stage flight runs over 60% of the stage height).
    await page.evaluate(() => {
      const r = document.getElementById('nova-hero-slot').getBoundingClientRect();
      window.scrollTo(0, window.scrollY + r.top - (64 - 0.55 * r.height));
    });
    await expect.poll(() => page.locator('html').evaluate((el) => Number(el.style.getPropertyValue('--hero-p')))).toBeGreaterThan(0.5);
    const mid = await avatar.boundingBox();
    expect(mid.width).toBeLessThan(start.width);
    await expect(page.locator('.nova-hero-copy')).toHaveCSS('opacity', '0');
    await expect(page.locator('#nova-input-row')).toHaveCSS('opacity', '0');
    await expect(page.locator('#nova-input-row')).toHaveCSS('pointer-events', 'none');
    await expect(widget).not.toHaveClass(/dock-mode/);

    // All the way: the dock takes over with the same box.
    await page.evaluate(() => window.scrollTo(0, 2000));
    await expect(widget).toHaveClass(/dock-mode/);
    const docked = await page.locator('#nova-video-wrap').boundingBox();
    expect(docked.width).toBeLessThanOrEqual(260);
    expect(docked.x + docked.width).toBeLessThanOrEqual(1440);
    expect(docked.y + docked.height).toBeLessThanOrEqual(900);

    // Back up: she returns to the stage.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(widget).not.toHaveClass(/dock-mode/);
    await expect.poll(async () => Math.abs((await avatar.boundingBox()).width - start.width)).toBeLessThan(2);
    await expect(page.locator('#nova-input-row')).toHaveCSS('opacity', '1');
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
  // Agents fetch these links directly, so every one must be absolute.
  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  expect(links.length).toBeGreaterThan(5);
  for (const href of links) expect(href).toMatch(/^https:\/\//);
});

test('every llms.txt link is a markdown twin an agent can read', async ({ request }) => {
  const body = await (await request.get('/llms.txt')).text();
  const link = [...body.matchAll(/\]\((https:\/\/[^)]+\.md)\)/g)][0]?.[1];
  expect(link).toBeTruthy();
  const res = await request.get(new URL(link).pathname.replace(/^\/intelligent-agents-sdk/, ''));
  expect(res.ok()).toBe(true);
  const md = await res.text();
  expect(md.startsWith('#')).toBe(true);
  expect(md).not.toContain('<html');
});

test('doc pages point to their markdown twin', async ({ page }) => {
  await page.goto(DOC);
  const href = await page.locator('link[rel="alternate"][type="text/markdown"]').getAttribute('href');
  expect(href).toMatch(/^https:\/\/.+\/index\.md$/);
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

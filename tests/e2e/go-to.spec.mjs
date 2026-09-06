import { test, expect } from './fixtures.mjs';

// End-to-end coverage of the go_to client tool as it runs on the real built
// site: the SDK's SiteNavigator (loaded through the same jsDelivr URL
// connect.js uses, answered from the pinned SDK checkout by fixtures.mjs so
// CI never hits the CDN), the build-time /nova/sections.json manifest, the
// SPA router and the dock highlight ring. The brain is replaced by an in-page
// fake session that fires tool calls; everything downstream of the tool call
// is real.

/**
 * Boot a SiteNavigator on the current page with a fake session and expose a
 * `goTo(args)` that resolves with the SiteNavInfo the navigator reports.
 * Mirrors the real wiring in connect.js (initSiteNav) rather than building
 * the navigator by hand, so the test covers the site's own adapter code.
 */
async function bootNav(page) {
  await page.evaluate(async () => {
    const listeners = new Map();
    const session = {
      state: 'connected',
      onToolCall(name, handler) {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
      on(event, handler) {
        listeners.set(`event:${event}`, handler);
        return () => listeners.delete(`event:${event}`);
      },
    };
    const { initSiteNav } = await import('/assets/nova/site-nav.js');
    let pending = null;
    const nav = initSiteNav(session, { onNavigate: (info) => pending?.(info) });
    await nav.ready;
    window.__goTo = (args) => new Promise((resolve) => {
      pending = resolve;
      listeners.get('go_to')(args);
    });
    window.__newTurn = () => listeners.get('event:turnStart')({ isNewTurn: true });
    window.__subscribed = () => [...listeners.keys()].sort();
    window.__nav = nav;
  });
}

const goTo = (page, args) => page.evaluate((a) => window.__goTo(a), args);

async function ringVisible(page) {
  return page.evaluate(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 200));
    return !!document.querySelector('.nova-highlight-ring');
  });
}

test('the build publishes /nova/sections.json and it lists the current page', async ({ page, request }) => {
  const res = await request.get('/nova/sections.json');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.version).toBe(1);
  expect(manifest.pages.length).toBeGreaterThan(10);
  await page.goto('/getting-started/');
  const path = await page.evaluate(() => location.pathname);
  const entry = manifest.pages.find((p) => p.path === path);
  expect(entry, `manifest has ${path}`).toBeTruthy();
  expect(entry.sections.length).toBeGreaterThan(0);
  for (const s of entry.sections) {
    expect(typeof s.key).toBe('string');
    expect(typeof s.id).toBe('string');
    expect(typeof s.text).toBe('string');
  }
});

test('the navigator loads the same manifest the build wrote', async ({ page, request }) => {
  await page.goto('/');
  await bootNav(page);
  const fromNav = await page.evaluate(() => window.__nav.manifest);
  const fromDisk = await (await request.get('/nova/sections.json')).json();
  expect(fromNav).toEqual(fromDisk);
});

test('go_to another page + section: routes, scrolls to the heading, sets the hash, highlights', async ({ page }) => {
  await page.goto('/');
  await bootNav(page);
  const target = await page.evaluate(() => {
    const p = window.__nav.manifest.pages.find((x) => x.path !== location.pathname && x.sections.length > 2);
    return { path: p.path, section: p.sections[p.sections.length - 1] };
  });

  const info = await goTo(page, { path: target.path, section: target.section.key });

  expect(info.dropped).toBeUndefined();
  expect(info.samePage).toBe(false);
  expect(info.sectionFound).toBe(true);
  expect(info.fellBackToTop).toBe(false);
  expect(info.sectionId).toBe(target.section.id);
  expect(await page.evaluate(() => location.pathname)).toBe(target.path);
  expect(await page.evaluate(() => location.hash)).toBe(`#${target.section.id}`);
  const inView = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, inView: r.bottom > 0 && r.top < window.innerHeight };
  }, target.section.id);
  expect(inView).toEqual({ found: true, inView: true });
  expect(await ringVisible(page)).toBe(true);
});

test('go_to a section on the current page: no route swap, scrolled and hash set', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  await bootNav(page);
  const target = await page.evaluate(() => {
    const p = window.__nav.manifest.pages.find((x) => x.path === location.pathname);
    return p.sections[p.sections.length - 1];
  });
  const before = await page.evaluate(() => window.scrollY);

  const info = await goTo(page, { path: '/reference/api-reference/', section: target.key });

  expect(info.dropped).toBeUndefined();
  expect(info.samePage).toBe(true);
  expect(info.sectionFound).toBe(true);
  expect(await page.evaluate(() => location.pathname)).toBe('/reference/api-reference/');
  expect(await page.evaluate(() => location.hash)).toBe(`#${target.id}`);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  expect(await ringVisible(page)).toBe(true);
});

test('go_to a page without a section lands at the top of that page', async ({ page }) => {
  await page.goto('/');
  await bootNav(page);
  const info = await goTo(page, { path: '/getting-started/' });
  expect(info.dropped).toBeUndefined();
  expect(info.section).toBeNull();
  expect(info.fellBackToTop).toBe(false);
  expect(await page.evaluate(() => location.pathname)).toBe('/getting-started/');
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('go_to with an unknown section still navigates, to the top, and reports the fallback', async ({ page }) => {
  await page.goto('/');
  await bootNav(page);
  const info = await goTo(page, { path: '/getting-started/', section: 'no such section here' });
  expect(info.dropped).toBeUndefined();
  expect(info.fellBackToTop).toBe(true);
  expect(info.section).toBeNull();
  expect(await page.evaluate(() => location.pathname)).toBe('/getting-started/');
});

test('go_to an unmapped path is dropped and the visitor stays put', async ({ page }) => {
  await page.goto('/getting-started/');
  await bootNav(page);
  const info = await goTo(page, { path: '/no/such/page/', section: 'anything' });
  expect(info).toMatchObject({ dropped: true, reason: 'unknown_path' });
  expect(await page.evaluate(() => location.pathname)).toBe('/getting-started/');
});

test('go_to runs once per brain turn; a new turn re-arms it', async ({ page }) => {
  await page.goto('/');
  await bootNav(page);
  const first = await goTo(page, { path: '/getting-started/' });
  expect(first.dropped).toBeUndefined();
  const second = await goTo(page, { path: '/reference/api-reference/' });
  expect(second).toMatchObject({ dropped: true, reason: 'once_per_turn' });
  expect(await page.evaluate(() => location.pathname)).toBe('/getting-started/');

  await page.evaluate(() => window.__newTurn());
  const third = await goTo(page, { path: '/reference/api-reference/' });
  expect(third.dropped).toBeUndefined();
  expect(await page.evaluate(() => location.pathname)).toBe('/reference/api-reference/');
});

test('destroy() unsubscribes every session listener (what resetUi relies on)', async ({ page }) => {
  await page.goto('/');
  await bootNav(page);
  expect(await page.evaluate(() => window.__subscribed())).toEqual(['event:turnStart', 'go_to']);
  await page.evaluate(() => window.__nav.destroy());
  expect(await page.evaluate(() => window.__subscribed())).toEqual([]);
  // Idempotent: a second destroy is harmless.
  await page.evaluate(() => window.__nav.destroy());
  expect(await page.evaluate(() => location.pathname)).toBe('/');
});

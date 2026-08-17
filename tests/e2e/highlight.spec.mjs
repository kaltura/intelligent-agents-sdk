import { test, expect } from '@playwright/test';

// Regression coverage for the self-inflicted scroll-echo race: highlighter.js's tool-call
// handler calls target.scrollIntoView() then pointAt(target) synchronously, but the browser
// always dispatches the resulting `scroll` event on a later tick — by then pointAt() has
// already attached its own scroll-interrupt listener, which used to treat that echo as a real
// user scroll and instantly kill the ring before it ever painted. Nothing in tests/eval can
// catch this: it only ever exercises a simulated tool ack, never this real scrollIntoView +
// pointAt DOM sequence.

test('pointAt ring survives its own caller scrollIntoView() without self-clearing', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  const result = await page.evaluate(async () => {
    const mod = await import('/assets/nova/dock.js');
    const headings = [...document.querySelectorAll('main.content-wrapper h2, main.content-wrapper h3')];
    const target = headings.find((h) => h.getBoundingClientRect().top > window.innerHeight) || headings[headings.length - 1];
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    mod.pointAt(target);
    for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 200));
    return { ringExists: !!document.querySelector('.nova-highlight-ring') };
  });
  expect(result.ringExists).toBe(true);
});

test('pointAt ring still clears on a genuine subsequent scroll', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  const result = await page.evaluate(async () => {
    const mod = await import('/assets/nova/dock.js');
    const target = document.querySelector('main.content-wrapper h2, main.content-wrapper h3');
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    mod.pointAt(target);
    await new Promise((r) => setTimeout(r, 150));
    window.scrollBy(0, 80);
    await new Promise((r) => setTimeout(r, 50));
    return { ringExists: !!document.querySelector('.nova-highlight-ring') };
  });
  expect(result.ringExists).toBe(false);
});

test('pointAt ring clears on window resize', async ({ page }) => {
  await page.goto('/reference/api-reference/');
  const result = await page.evaluate(async () => {
    const mod = await import('/assets/nova/dock.js');
    const target = document.querySelector('main.content-wrapper h2, main.content-wrapper h3');
    target.scrollIntoView({ behavior: 'auto', block: 'center' });
    mod.pointAt(target);
    await new Promise((r) => setTimeout(r, 100));
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 20));
    return { ringExists: !!document.querySelector('.nova-highlight-ring') };
  });
  expect(result.ringExists).toBe(false);
});

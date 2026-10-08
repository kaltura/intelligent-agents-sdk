import { test, expect } from './fixtures.mjs';

// The `show_signup_link` client tool takes no arguments. The page adds a
// sign-up button to the transcript and owns its label and address. The test
// types a question (this starts a text chat), answers the three backend
// calls locally, and streams a reply with the tool call in it.

const SIGNUP_URL = 'https://corp.kaltura.com/pricing/conversational-agent/';

async function askWithReply(page, segments) {
  await page.route(/\/service\/session\/action\/startWidgetSession/, (route) =>
    route.fulfill({ json: { ks: 'test-widget-ks' } }));
  await page.route(/\/application\/appInit/, (route) =>
    route.fulfill({ json: { ks: 'test-conversation-ks' } }));
  await page.route(/\/assistant\/converse/, (route) => route.fulfill({
    contentType: 'application/x-ndjson',
    body: [...segments, { type: 'text', content: 'It is MIT licensed.', isFinal: true }]
      .map((s) => `${JSON.stringify({ threadId: 't-1', ...s })}\n`).join(''),
  }));
  await page.route(/\/thread\/session_completed/, (route) => route.fulfill({ json: {} }));

  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  await page.locator('#nova-input').fill('Is this free?');
  await page.locator('#nova-input').press('Enter');
  await expect(page.locator('#nova-transcript .nova-nova')).toContainText('MIT licensed');
}

test('show_signup_link adds a sign-up button with the fixed address', async ({ page }) => {
  await askWithReply(page, [{ type: 'tool', content: 'show_signup_link' }]);
  const cta = page.locator('#nova-transcript a.nova-cta');
  await expect(cta).toHaveCount(1);
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText('Sign up');
  await expect(cta).toHaveAttribute('href', SIGNUP_URL);
  await expect(cta).toHaveAttribute('target', '_blank');
  await expect(cta).toHaveAttribute('rel', /noopener/);
});

test('show_signup_link ignores any argument the model sends', async ({ page }) => {
  await askWithReply(page, [{ type: 'tool', content: 'show_signup_link {"url":"https://attacker.example/","label":"<b>Click</b>"}' }]);
  const cta = page.locator('#nova-transcript a.nova-cta');
  await expect(cta).toHaveCount(1);
  await expect(cta).toHaveAttribute('href', SIGNUP_URL);
  await expect(cta).toHaveText('Sign up');
});

test('a repeated show_signup_link call still shows one button', async ({ page }) => {
  await askWithReply(page, [
    { type: 'tool', content: 'show_signup_link {"n":1}' },
    { type: 'tool', content: 'show_signup_link {"n":2}' },
  ]);
  await expect(page.locator('#nova-transcript a.nova-cta')).toHaveCount(1);
});

test('no tool call, no sign-up button', async ({ page }) => {
  await askWithReply(page, []);
  await expect(page.locator('#nova-transcript a.nova-cta')).toHaveCount(0);
});

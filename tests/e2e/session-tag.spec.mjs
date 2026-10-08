import { test, expect } from './fixtures.mjs';

// Dev and automated runs mark their Nova session with the `nova_session_kind`
// request var, so metrics can leave them out. A real visitor sends no such
// var. The test types a question (this starts a text chat) and reads the request_vars of the first
// turn the page sends. All three backend calls are answered locally.

test.use({ launchOptions: { args: ['--host-resolver-rules=MAP docs.example.test 127.0.0.1'] } });

async function firstTurnVars(page, url) {
  let body;
  await page.route(/\/service\/session\/action\/startWidgetSession/, (route) =>
    route.fulfill({ json: { ks: 'test-widget-ks' } }));
  await page.route(/\/application\/appInit/, (route) =>
    route.fulfill({ json: { ks: 'test-conversation-ks' } }));
  await page.route(/\/assistant\/converse/, (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ type: 'text', content: 'Hi', threadId: 't-1', isFinal: true })}\n`,
    });
  });
  await page.route(/\/thread\/session_completed/, (route) => route.fulfill({ json: {} }));

  await page.goto(url);
  await expect(page.locator('html')).toHaveClass(/nova-ready/);
  await page.locator('#nova-input').fill('What is the SDK?');
  await page.locator('#nova-input').press('Enter');
  await expect.poll(() => body, { timeout: 15_000 }).toBeTruthy();
  return body.request_vars;
}

test.describe('automated browser', () => {
  test('a Playwright run tags the session as automated', async ({ page }) => {
    const vars = await firstTurnVars(page, '/');
    expect(vars.nova_session_kind).toBe('automated');
  });
});

test.describe('dev host, no automation flag', () => {
  test('a localhost run tags the session as dev', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const vars = await firstTurnVars(page, '/');
    expect(vars.nova_session_kind).toBe('dev');
  });
});

test.describe('normal-looking visit', () => {
  // docs.example.test resolves to the local test server, so the page host is
  // not a dev host. The automation flag is switched off.
  test.use({ baseURL: 'http://docs.example.test:8811' });

  test('sends no session tag', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const vars = await firstTurnVars(page, '/');
    expect(vars).toBeDefined();
    expect(vars).not.toHaveProperty('nova_session_kind');
    expect(vars).toHaveProperty('nova_greet');
  });
});

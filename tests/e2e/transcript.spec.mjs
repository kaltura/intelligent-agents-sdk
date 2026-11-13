import { test, expect } from './fixtures.mjs';

// transcript.js is the pure-DOM rendering layer connect.js drives at runtime:
// speaker-labeled messages, streaming same-speaker glue, and the "Nova is
// thinking" dots. A live session can't run in CI, so these drive the module
// directly against the real #nova-transcript element and the shipped CSS —
// the when-to-show/hide wiring (first reply segment, error, mode switch)
// lives in connect.js and is exercised by the docs-site-avatar live eval.

async function setup(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const mod = await import('/assets/nova/transcript.js');
    mod.initTranscript(document.getElementById('nova-transcript'));
    window.__transcript = mod;
  });
}

test('speaker labels are bold and carry distinct Kaltura palette colors', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('you', 'What is GenUI?');
    window.__transcript.appendTranscript('nova', 'GenUI renders widgets.');
  });

  const youLabel = page.locator('.nova-you .nova-label');
  const novaLabel = page.locator('.nova-nova .nova-label');
  await expect(youLabel).toHaveText('You:');
  await expect(novaLabel).toHaveText('Nova:');

  const [youStyle, novaStyle] = await Promise.all([
    youLabel.evaluate((el) => { const s = getComputedStyle(el); return { weight: s.fontWeight, color: s.color }; }),
    novaLabel.evaluate((el) => { const s = getComputedStyle(el); return { weight: s.fontWeight, color: s.color }; }),
  ]);
  expect(Number(youStyle.weight)).toBeGreaterThanOrEqual(700);
  expect(Number(novaStyle.weight)).toBeGreaterThanOrEqual(700);
  expect(youStyle.color).not.toBe(novaStyle.color);
  // Each label must be colored, not inherit its message body's color.
  const bodyColor = await page.locator('.nova-you .nova-msg').evaluate((el) => getComputedStyle(el).color);
  expect(youStyle.color).not.toBe(bodyColor);
});

test('consecutive same-speaker segments glue into one paragraph with a single label', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('nova', 'First segment.');
    window.__transcript.appendTranscript('nova', 'Second segment.');
  });
  await expect(page.locator('.nova-nova')).toHaveCount(1);
  await expect(page.locator('.nova-nova .nova-label')).toHaveCount(1);
  await expect(page.locator('.nova-nova .nova-msg')).toHaveText('First segment. Second segment.');
});

test('thinking dots render four Kaltura-colored dots, stay below new messages, and clear', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__transcript.showThinking());

  const thinking = page.locator('.nova-thinking');
  await expect(thinking).toHaveAttribute('role', 'status');
  await expect(thinking.locator('span')).toHaveCount(4);
  const colors = await thinking.locator('span').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colors).size).toBe(4);
  const animated = await thinking.locator('span').first().evaluate((el) => getComputedStyle(el).animationName);
  expect(animated).toBe('nova-think-bounce');

  // A message arriving while the dots are up lands above them, and a second
  // showThinking() while one is already up doesn't stack another.
  await page.evaluate(() => {
    window.__transcript.appendTranscript('you', 'still there?');
    window.__transcript.showThinking();
  });
  await expect(thinking).toHaveCount(1);
  const lastIsThinking = await page.evaluate(() =>
    document.getElementById('nova-transcript').lastElementChild.className === 'nova-thinking');
  expect(lastIsThinking).toBe(true);

  await page.evaluate(() => window.__transcript.hideThinking());
  await expect(thinking).toHaveCount(0);
});

test('ASR/TTS control tokens like "<blank>" never render, even mid-glue', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('nova', '<blank>');
    window.__transcript.appendTranscript('you', '  <blank>  ');
    window.__transcript.appendTranscript('nova', 'Real reply.');
    window.__transcript.appendTranscript('nova', '<blank>');
    window.__transcript.appendTranscript('nova', 'still real.');
  });
  await expect(page.locator('#nova-transcript > *')).toHaveCount(1);
  await expect(page.locator('.nova-nova .nova-msg')).toHaveText('Real reply. still real.');
});

test('Nova replies render markdown from DOM nodes; the visitor line stays literal', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('you', 'what is **this** `x`?');
    window.__transcript.appendTranscript('nova', 'Use **bold**, `code()`, [docs](/getting-started/) and https://example.com/a.\n- one\n- two\n1. first');
  });
  const you = page.locator('.nova-you .nova-msg');
  await expect(you).toHaveText('what is **this** `x`?');
  await expect(you.locator('strong, code')).toHaveCount(0);

  const nova = page.locator('.nova-nova .nova-msg');
  await expect(nova.locator('strong')).toHaveText('bold');
  await expect(nova.locator('code')).toHaveText('code()');
  await expect(nova.locator('a[href$="/getting-started/"]')).toHaveText('docs');
  const ext = nova.locator('a[href="https://example.com/a"]');
  await expect(ext).toHaveAttribute('target', '_blank');
  await expect(ext).toHaveAttribute('rel', /noopener/);
  await expect(nova.locator('.nova-list-item')).toHaveCount(3);
  await expect(nova.locator('.nova-list-item').nth(2)).toHaveAttribute('data-marker', '1.');
});

test('unsafe link schemes and markup in a Nova reply stay as text', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('nova', '[x](javascript:alert(1)) <img src=x onerror=alert(2)> [y](//evil.test/) [z](/\\evil.test/)');
  });
  const nova = page.locator('.nova-nova .nova-msg');
  await expect(nova.locator('a')).toHaveCount(0);
  await expect(nova.locator('img')).toHaveCount(0);
  await expect(nova).toContainText('<img src=x onerror=alert(2)>');
});

test('streamed segments re-render as one markdown message', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__transcript.appendTranscript('nova', 'This is **bo');
    window.__transcript.appendTranscript('nova', 'ld** text.');
  });
  await expect(page.locator('.nova-nova .nova-msg strong')).toHaveText('bo ld');
});

test('reading older messages is not yanked to the bottom; a jump pill brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await page.evaluate(() => {
    // A transcript only shows in a live call, so give the stage its live state.
    document.documentElement.classList.add('nova-live');
    const t = document.getElementById('nova-transcript');
    t.style.cssText = 'display:block;height:120px;overflow-y:auto';
    for (let i = 0; i < 30; i++) window.__transcript.appendTranscript(i % 2 ? 'you' : 'nova', `line ${i}`);
    t.scrollTop = 0;
  });
  await page.evaluate(() => window.__transcript.appendTranscript('nova', 'late reply'));
  const top = await page.evaluate(() => document.getElementById('nova-transcript').scrollTop);
  expect(top).toBe(0);
  const jump = page.locator('.nova-jump');
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  const pinned = await page.evaluate(() => {
    const t = document.getElementById('nova-transcript');
    return t.scrollHeight - t.scrollTop - t.clientHeight <= 48;
  });
  expect(pinned).toBe(true);
});

// On a spoken turn the server sends the visitor's words after Nova's first
// sentence. The SDK stamps both with the reply's speechId; the page uses it to
// put the visitor's line first.
const order = (page) => page.locator('#nova-transcript > .nova-you, #nova-transcript > .nova-nova').evaluateAll((els) =>
  els.map((el) => `${el.className === 'nova-you' ? 'you' : 'nova'}:${el.querySelector('.nova-msg').dataset.raw}`));

test('a spoken visitor line that arrives after the reply goes in front of it', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('nova', 'Goodbye!', 's1');
    t.appendTranscript('you', 'Bye.', 's1');
  });
  expect(await order(page)).toEqual(['you:Bye.', 'nova:Goodbye!']);
});

test('a multi-sentence reply stays one paragraph under its visitor line', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('nova', 'First.', 's1');
    t.appendTranscript('you', 'Explain.', 's1');
    t.appendTranscript('nova', 'Second.', 's1');
  });
  expect(await order(page)).toEqual(['you:Explain.', 'nova:First. Second.']);
});

test('back-to-back spoken turns keep speaking order', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('nova', 'Answer one.', 'a');
    t.appendTranscript('you', 'Question one?', 'a');
    t.appendTranscript('nova', 'Answer two.', 'b');
    t.appendTranscript('you', 'Question two?', 'b');
    t.appendTranscript('nova', 'More two.', 'b');
  });
  expect(await order(page)).toEqual([
    'you:Question one?', 'nova:Answer one.', 'you:Question two?', 'nova:Answer two. More two.',
  ]);
});

test('a visitor line goes before its own reply, never before an earlier turn', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('nova', 'A.', 'a');
    t.appendTranscript('nova', 'B.', 'b');
    t.appendTranscript('you', 'Q2', 'b');
  });
  expect(await order(page)).toEqual(['nova:A.', 'you:Q2', 'nova:B.']);
});

test('lines without a speechId keep arrival order and glue as before', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('you', 'typed');
    t.appendTranscript('nova', 'One.');
    t.appendTranscript('nova', 'Two.');
    t.appendTranscript('you', 'spoken with no reply seen', 'unseen');
  });
  expect(await order(page)).toEqual(['you:typed', 'nova:One. Two.', 'you:spoken with no reply seen']);
});

test('the thinking dots stay last when a visitor line is placed before a reply', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.__transcript;
    t.appendTranscript('nova', 'Hi.', 's1');
    t.showThinking();
    t.appendTranscript('you', 'Hello', 's1');
  });
  expect(await order(page)).toEqual(['you:Hello', 'nova:Hi.']);
  const lastIsThinking = await page.evaluate(() =>
    document.getElementById('nova-transcript').lastElementChild.className === 'nova-thinking');
  expect(lastIsThinking).toBe(true);
});

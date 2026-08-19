// Proves issue #18's Phase-1 "Clean code" rules 2 and 3: every example's
// <video> element is framed with object-fit, and the videoEl JSDoc in both
// session classes cross-links docs/ARCHITECTURE.md's new section.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, repoRoot), 'utf8');

describe('examples: <video> is framed with object-fit (issue #18)', () => {
  test('browser-experience.html — video is appended into #avatar, styled via "#avatar video"', () => {
    const html = read('examples/browser-experience.html');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(style, /#avatar\s+video\s*\{[^}]*object-fit\s*:\s*cover/);
  });

  test('deck-presenter.html — video is appended into #avatar, styled via "#avatar video"', () => {
    const html = read('examples/deck-presenter.html');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(style, /#avatar\s+video\s*\{[^}]*object-fit\s*:\s*cover/);
  });

  test('scripted-video-session.html — bare <video id="video">, styled via the bare "video" selector', () => {
    const html = read('examples/scripted-video-session.html');
    assert.match(html, /<video\s+id="video"/);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(style, /(?<![#.\w-])video\s*\{[^}]*object-fit\s*:\s*cover/);
  });
});

describe('videoEl JSDoc cross-links docs/ARCHITECTURE.md (issue #18)', () => {
  test('KalturaAvatarSession (session.js)', () => {
    const src = read('src/experience/session.js');
    const line = src.split('\n').find((l) => l.includes('@param {any} [cfg.videoEl]'));
    assert.ok(line, 'expected a @param {any} [cfg.videoEl] JSDoc line');
    assert.match(line, /ARCHITECTURE\.md.*Displaying the Avatar Video/);
  });

  test('KalturaScriptedVideoSession (scripted-video-session.js)', () => {
    const src = read('src/experience/scripted-video-session.js');
    const line = src.split('\n').find((l) => l.includes('@param {any} [cfg.videoEl]'));
    assert.ok(line, 'expected a @param {any} [cfg.videoEl] JSDoc line');
    assert.match(line, /ARCHITECTURE\.md.*Displaying the Avatar Video/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { thumbnailUrl, playerEmbedUrl, externalEmbedUrl } from '../../src/core/kaltura-media.js';

/** Kaltura media-URL helpers — pure, no DOM, no network. */

// ─────────────────────────── thumbnailUrl / playerEmbedUrl ───────────────

test('thumbnailUrl builds the canonical CDN path, optionally with width', () => {
  assert.equal(
    thumbnailUrl('1_abc123', '12345'),
    'https://cfvod.kaltura.com/p/12345/sp/1234500/thumbnail/entry_id/1_abc123',
  );
  assert.equal(
    thumbnailUrl('1_abc123', 12345, { width: 320 }),
    'https://cfvod.kaltura.com/p/12345/sp/1234500/thumbnail/entry_id/1_abc123/width/320',
  );
  assert.equal(thumbnailUrl('', '12345'), '');
  assert.equal(thumbnailUrl('1_abc123', 'not-a-number'), '');
});

test('playerEmbedUrl builds the extwidget/preview iframe src', () => {
  assert.equal(
    playerEmbedUrl('1_abc123', '12345'),
    'https://www.kaltura.com/index.php/extwidget/preview/partner_id/12345/entry_id/1_abc123/embed/iframe',
  );
  assert.equal(
    playerEmbedUrl('1_abc123', '12345', { uiConfId: '99; DROP TABLE' }),
    'https://www.kaltura.com/index.php/extwidget/preview/partner_id/12345/uiconf_id/99/entry_id/1_abc123/embed/iframe',
  );
});

// ─────────────────────────── externalEmbedUrl ────────────────────────────

test('externalEmbedUrl recognizes every YouTube URL shape via exact host match', () => {
  const id = 'abc12345';
  const nocookie = `https://www.youtube-nocookie.com/embed/${id}`;
  assert.deepEqual(externalEmbedUrl(`https://www.youtube.com/watch?v=${id}`), { embedUrl: nocookie, provider: 'YouTube' });
  assert.deepEqual(externalEmbedUrl(`https://www.youtube.com/watch?foo=1&v=${id}`), { embedUrl: nocookie, provider: 'YouTube' });
  assert.deepEqual(externalEmbedUrl(`https://www.youtube.com/watch?foo=1&bar=2&v=${id}`), { embedUrl: nocookie, provider: 'YouTube' });
  assert.deepEqual(externalEmbedUrl(`https://youtu.be/${id}`), { embedUrl: nocookie, provider: 'YouTube' });
  assert.deepEqual(externalEmbedUrl(`https://www.youtube.com/embed/${id}`), { embedUrl: nocookie, provider: 'YouTube' });
  assert.deepEqual(externalEmbedUrl(`https://www.youtube.com/shorts/${id}`), { embedUrl: nocookie, provider: 'YouTube' });
});

test('externalEmbedUrl recognizes both Vimeo URL shapes', () => {
  assert.deepEqual(externalEmbedUrl('https://vimeo.com/1234567'), { embedUrl: 'https://player.vimeo.com/video/1234567', provider: 'Vimeo' });
  assert.deepEqual(externalEmbedUrl('https://player.vimeo.com/video/1234567'), { embedUrl: 'https://player.vimeo.com/video/1234567', provider: 'Vimeo' });
});

test('externalEmbedUrl rejects a lookalike host — the youtube.com match is host-exact, not substring', () => {
  assert.deepEqual(externalEmbedUrl('https://evil.com/?redirect=youtube.com/watch?v=abcdefgh'), { embedUrl: '', provider: '' });
  assert.deepEqual(externalEmbedUrl('https://notyoutube.com/watch?v=abcdefgh'), { embedUrl: '', provider: '' });
  assert.deepEqual(externalEmbedUrl('https://youtube.com.evil.com/watch?v=abcdefgh'), { embedUrl: '', provider: '' });
});

test('externalEmbedUrl falls back to a plain link for anything else, never throws', () => {
  assert.deepEqual(externalEmbedUrl('not a url'), { embedUrl: '', provider: '' });
  assert.deepEqual(externalEmbedUrl(''), { embedUrl: '', provider: '' });
  assert.deepEqual(externalEmbedUrl(null), { embedUrl: '', provider: '' });
  assert.deepEqual(externalEmbedUrl('https://example.com/video.mp4'), { embedUrl: '', provider: '' });
});

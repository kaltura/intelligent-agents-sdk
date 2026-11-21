// Showroom example: every file the stylesheet and the server need for the scene exists, and stays small.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const dir = new URL('../../examples/showroom/', import.meta.url);

describe('scene background', () => {
  const css = readFileSync(new URL('styles/stage.css', dir), 'utf8');
  const urls = [...css.matchAll(/--scene:\s*url\("([^"]+)"\)/g)].map((m) => m[1]);

  test('the stylesheet names a portrait and a landscape photo, shared by the dark and light themes', () => {
    assert.equal(urls.length, 2);
  });
  test('each photo exists, is a WebP and stays under 120 KB', () => {
    for (const u of urls) {
      const file = new URL(`styles/${u}`, dir);
      const { size } = statSync(file);
      assert.ok(size > 0 && size < 120 * 1024, `${u} is ${size} bytes`);
      assert.equal(readFileSync(file).subarray(8, 12).toString('ascii'), 'WEBP', `${u} is not a WebP`);
    }
  });
  test('the dev server serves WebP', () => {
    assert.match(readFileSync(new URL('server.mjs', dir), 'utf8'), /'\.webp':\s*'image\/webp'/);
  });
});

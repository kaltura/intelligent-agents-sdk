import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInit, parseConfig } from '../../examples/showroom/js/init.js';

const reply = (ok, body) => ({ ok, json: async () => body });

describe('showroom start-up data', () => {
  test('parseConfig wants numeric partner and a plain widget id', () => {
    assert.deepEqual(parseConfig({ partnerId: 123, widgetId: '1_abc' }), { partnerId: '123', widgetId: '1_abc' });
    for (const bad of [null, {}, { partnerId: 'x', widgetId: '1_a' }, { partnerId: '1', widgetId: '' }, { partnerId: '1', widgetId: '../x' }]) assert.equal(parseConfig(bad), null);
  });

  test('with a config file the browser mints a widget token with no secret and calls appInit', async () => {
    const calls = [];
    class Management {
      constructor(cfg) { calls.push(['new', cfg]); this.sessions = { createWidgetToken: async (o) => { calls.push(['widget', o]); return { ks: 'KS' }; } }; this.application = { appInit: async (ks) => { calls.push(['appInit', ks]); return { ks: 'CONV' }; } }; }
    }
    const out = await loadInit({ fetchFn: async (u) => (u === 'config.json' ? reply(true, { partnerId: '5', widgetId: '1_w' }) : assert.fail(u)), loadManagement: async () => ({ Management }) });
    assert.deepEqual(out, { ks: 'CONV' });
    assert.deepEqual(calls, [['new', { partnerId: '5' }], ['widget', { widgetId: '1_w' }], ['appInit', 'KS']]);
  });

  test('without a config file it asks the local server', async () => {
    const seen = [];
    const out = await loadInit({ fetchFn: async (u) => { seen.push(u); return u === 'config.json' ? reply(false) : reply(true, { ks: 'S' }); } });
    assert.deepEqual(out, { ks: 'S' });
    assert.deepEqual(seen, ['config.json', '/appInit']);
  });

  test('a host that answers config.json with a web page counts as no config', async () => {
    const out = await loadInit({ fetchFn: async (u) => (u === 'config.json' ? { ok: true, json: async () => { throw new SyntaxError('html'); } } : reply(true, { ks: 'S' })) });
    assert.deepEqual(out, { ks: 'S' });
  });

  test('a server that says no is an error with a hint', async () => {
    await assert.rejects(loadInit({ fetchFn: async (u) => reply(u !== 'config.json' && false) }), /provision script/);
  });
});

describe('pack-showroom', () => {
  const script = new URL('../../scripts/pack-showroom.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  test('writes a static site with the lite body, the SDK and the config, and nothing private', () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'pack-')), 'site');
    try {
      assert.equal(run(out, '--partner=77', '--widget=1_zz').status, 0);
      assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'examples/showroom/config.json'), 'utf8')), { partnerId: '77', widgetId: '1_zz' });
      assert.ok(existsSync(path.join(out, 'index.html')));
      assert.ok(existsSync(path.join(out, 'src/management/index.js')));
      assert.ok(existsSync(path.join(out, 'examples/showroom/bodies/guide-lite/manifest.json')));
      assert.ok(!existsSync(path.join(out, 'examples/showroom/bodies/guide')), 'full-size body stays out');
      assert.ok(!existsSync(path.join(out, 'examples/showroom/agent')), 'provisioning stays out');
      const files = execFileSync('find', [out, '-type', 'f'], { encoding: 'utf8' }).split('\n');
      assert.ok(!files.some((f) => /agent\.json|\.env/.test(f)));
    } finally { rmSync(path.dirname(out), { recursive: true, force: true }); }
  });

  test('refuses bad input, a non-empty folder and a folder inside the repo', () => {
    assert.equal(run().status, 2);
    assert.equal(run('/tmp/x-never', '--partner=abc', '--widget=1_a').status, 2);
    const dir = mkdtempSync(path.join(tmpdir(), 'pack-'));
    try {
      assert.equal(run(dir, '--partner=1', '--widget=1_a').status, 0);
      assert.equal(run(dir, '--partner=1', '--widget=1_a').status, 2, 'second run into a filled folder');
      assert.equal(run(path.join(path.dirname(script), 'out-x'), '--partner=1', '--widget=1_a').status, 2, 'inside the repo');
      assert.ok(readdirSync(dir).length > 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

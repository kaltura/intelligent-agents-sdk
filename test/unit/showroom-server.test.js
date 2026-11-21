import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const script = new URL('../../examples/showroom/server.mjs', import.meta.url).pathname;
let proc; let base;

const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

describe('showroom dev server file rules', () => {
  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [script], { env: { PORT: String(port), PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { proc.stdout.on('data', (d) => /Showroom on/.test(String(d)) && resolve()); proc.on('exit', () => reject(new Error('server exited'))); });
  });
  after(() => proc?.kill());

  const status = (p) => fetch(base + p).then((r) => r.status);

  test('serves the page and the SDK source', async () => {
    assert.equal(await status('/examples/showroom/index.html'), 200);
    assert.equal(await status('/src/management/index.js'), 200);
  });

  test('never serves the agent folder, in any letter case', async () => {
    for (const p of ['agent/provision.mjs', 'AGENT/provision.mjs', 'Agent/spec.mjs', '%41gent/spec.mjs', 'agent/agent.json']) assert.equal(await status(`/examples/showroom/${p}`), 404, p);
  });

  test('stays inside the two served folders and hides dotfiles', async () => {
    for (const p of ['/examples/showroom/%2e%2e/%2e%2e/package.json', '/src/../package.json', '/package.json', '/examples/showroom/js/../../../.git/config', '/src/%2e%2e/.env']) assert.equal(await status(p), 404, p);
  });

  test('answers byte-range requests, which Safari needs for video', async () => {
    const r = await fetch(`${base}/examples/showroom/index.html`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206);
    assert.equal((await r.arrayBuffer()).byteLength, 10);
  });
});

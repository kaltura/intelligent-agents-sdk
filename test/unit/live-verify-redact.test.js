import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../scripts/lib/redact.mjs';

test('live-verify redact hides KS tokens, query strings, avatar stream and session ids, and UUIDs', () => {
  const line = 'POST host.example/rtc/v1/stv/AbC-123_xyz/whep/session/a0afa851-a61e-4c47-ac81-6dbcff709f80 → 404';
  assert.equal(redact(line), 'POST host.example/rtc/v1/stv/<id>/whep/session/<id> → 404');
  assert.equal(redact('wss://h.example/socket?partnerId=123&x=1'), 'wss://h.example/socket?<query>');
  assert.equal(redact('ks djJ8abcDEF012_-xyz end'), 'ks <KS> end');
  assert.equal(redact('id 123e4567-e89b-12d3-a456-426614174000.'), 'id <uuid>.');
});

test('Report.check and Report.note redact what they print and write', async () => {
  const { Report } = await import('../../scripts/live-verify-kickoff-shared.mjs');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const line = 'DELETE /rtc/v1/stv/KdB5IACdO9wCfbJsUMO0O1_nIEVm3nM6Do3gno6GTzk/whep/session/cc9f7e2f-608e-49fc-b20b-3d9ff2c99767';
  const printed = [];
  const orig = console.log;
  console.log = (s) => printed.push(String(s));
  const dir = mkdtempSync(join(tmpdir(), 'redact-'));
  try {
    const r = new Report({ runId: 't', target: 'x' });
    r.check('c', true, { line });
    r.note('n', [line]);
    r.write(dir, `| ${line} |`);
  } finally { console.log = orig; }
  const all = [...printed, readFileSync(join(dir, 't.json'), 'utf8'), readFileSync(join(dir, 't.md'), 'utf8')].join('\n');
  assert.doesNotMatch(all, /KdB5IACd|cc9f7e2f/);
  assert.match(all, /stv\/<id>\/whep\/session\/<id>/);
});

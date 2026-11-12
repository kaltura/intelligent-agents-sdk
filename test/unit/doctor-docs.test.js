import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCTOR_CODES } from '../../src/management/doctor/checks/index.js';

const page = readFileSync(new URL('../../docs/DOCTOR.md', import.meta.url), 'utf8');

test('docs/DOCTOR.md has a table row for every code the doctor defines', () => {
  const rows = page.split('\n').filter((l) => l.startsWith('| `'));
  const missing = DOCTOR_CODES.filter((code) => !rows.some((r) => r.startsWith(`| \`${code}\` |`)));
  assert.deepEqual(missing, []);
});

test('docs/DOCTOR.md lists no finding code the doctor does not define', () => {
  const documented = page.split('\n').flatMap((l) => l.match(/^\| `([a-z]+_[a-z_]+)` \|/)?.slice(1) ?? []);
  assert.deepEqual(documented.filter((c) => !DOCTOR_CODES.includes(c)), []);
});

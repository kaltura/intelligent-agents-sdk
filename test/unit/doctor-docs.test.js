import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOCTOR_CODES } from '../../src/management/doctor/checks/index.js';

/** The code tables in docs/DOCTOR.md and the registry must list the same codes. */

const doc = readFileSync(new URL('../../docs/DOCTOR.md', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../../docs/lifecycle/README.md', import.meta.url), 'utf8');
/** First cell of every table row in the "Finding codes" section. */
const codesSection = doc.slice(doc.indexOf('## Finding codes'), doc.indexOf('## Fix what it can'));
const documented = [...codesSection.matchAll(/^\| `([a-z][a-z0-9_]+)` \|/gm)].map((m) => m[1]);

test('every doctor code has a row in docs/DOCTOR.md or the lifecycle audit doc', () => {
  const missing = DOCTOR_CODES.filter((c) => !documented.includes(c) && !lifecycle.includes(`\`${c}\``));
  assert.deepEqual(missing, []);
});

test('every code row in docs/DOCTOR.md is a code the doctor can emit', () => {
  const extra = documented.filter((c) => !DOCTOR_CODES.includes(c));
  assert.deepEqual(extra, []);
});

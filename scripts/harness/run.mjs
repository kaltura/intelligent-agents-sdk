#!/usr/bin/env node
/**
 * Permanent harness for issues #15-#20 (avatar visual pipeline / video
 * display / prompt-identity work) and every future change touching the same
 * area. Reuses existing gates rather than duplicating them — `npm run verify`
 * (scripts/agent_verify.mjs) already runs the full test suite plus the
 * grep-based isolation/security/dead-code/DX checks (SDK_CONSTITUTION.md
 * Rules I-1..D-3), so gates 1/3/4/5/6 below are that single call. The only
 * gate genuinely missing from existing infra is a general SAST pass, so this
 * adds semgrep against scripts/harness/semgrep-rules.yml, plus the docs gate.
 *
 * Usage: node scripts/harness/run.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(ROOT, '.harness-output');

const GATES = [
  {
    name: 'Lint + isolation + dead-code + unit/integration/e2e (npm run verify)',
    run: () => spawnSync('npm', ['run', 'verify'], { cwd: ROOT, encoding: 'utf8' }),
  },
  {
    name: 'SAST (semgrep, scripts/harness/semgrep-rules.yml)',
    run: () => spawnSync('semgrep', ['--config', 'scripts/harness/semgrep-rules.yml', '--error', 'src', 'test', 'tools', 'scripts', 'examples'], { cwd: ROOT, encoding: 'utf8' }),
  },
  {
    name: 'Docs/code drift + secrets + GFM hygiene (npm run docs:gate)',
    run: () => spawnSync('npm', ['run', 'docs:gate'], { cwd: ROOT, encoding: 'utf8' }),
  },
];

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const gate of GATES) {
  const res = gate.run();
  const ok = res.status === 0;
  results.push({ name: gate.name, ok, status: res.status });
  writeFileSync(
    join(OUT_DIR, `${gate.name.split('(')[0].trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`),
    `${res.stdout || ''}\n${res.stderr || ''}`,
  );
  console.log(`${ok ? '✅' : '❌'} ${gate.name}`);
  if (!ok) console.log((res.stdout || '') + (res.stderr || ''));
}

const allOk = results.every((r) => r.ok);
console.log('\n' + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'));
process.exit(allOk ? 0 : 1);

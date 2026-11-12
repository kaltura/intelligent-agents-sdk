import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/doctor.mjs` end to end: flags, output shapes, exit codes and --fix,
 * against a local HTTP server that stands in for the backends. No real network.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = resolve(root, 'scripts/doctor.mjs');
const SECRET = 'cli-test-secret-value-9f3';
const VOICE = { itemId: 'v1', type: 'Voice', adminTags: ['preset'], attributes: { voice: { name: 'Maya', language: 'he' } } };

const fresh = () => ({
  asr: { language: 'en', provider: 'kaltura' }, forced: 'Hebrew', mintOk: true, writes: [], requests: [], rules: [], converseBodies: [],
});
const state = fresh();

let server;
let base;
let tmp;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-cli-'));
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    state.requests.push(`${req.method} ${path}`);
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw.startsWith('{') ? JSON.parse(raw) : {};
      const send = (b, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const page = (all) => { const { offset = 0, limit = 30 } = body.pager ?? {}; send({ objects: all.slice(offset, offset + limit), totalCount: all.length }); };
      if (path.endsWith('/session/action/start')) return send(state.mintOk ? `djJ8${'A'.repeat(40)}` : { objectType: 'KalturaAPIException', message: 'denied', code: 'DENIED' });
      if (path.endsWith('/lifecycle/list')) return page(state.rules);
      if (path.endsWith('/assistant/converse')) {
        state.converseBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${JSON.stringify({ type: 'think', content: '', threadId: 't', messageId: 'm' })}\n${JSON.stringify({ type: 'text', content: 'Hello there' })}\n`);
      }
      if (path.endsWith('/insight-settings/list') || path.endsWith('/email-template/list')) return page([]);
      if (path.endsWith('/agent/list')) return page([{ agentId: 'a1', intellect: { id: 10 }, avatarIds: ['av1'], asr: state.asr }]);
      if (path.endsWith('/agent/get')) return send({ agentId: 'a1', intellect: { id: 10 }, asr: state.asr });
      if (path.endsWith('/agent/update')) { state.writes.push(body); state.asr = body.asr; return send({ agentId: 'a1', ...body }); }
      if (path.endsWith('/intellect/get')) return send({ id: 10, type: 'brain', force_language: state.forced });
      if (path.endsWith('/avatar/list')) return page([{ id: 'av1', voice: { id: 'v1' }, visual: { id: 'vis1' } }]);
      if (path.endsWith('/catalog-item/list')) return page(body.filter?.typeEqual === 'Voice' ? [VOICE] : [{ itemId: 'vis1', type: 'Visual' }]);
      return send({ message: 'not found' }, 404);
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((ok) => { rmSync(tmp, { recursive: true, force: true }); server.close(ok); server.closeAllConnections?.(); }));

function run(args, { set } = {}) {
  Object.assign(state, fresh(), set);
  const env = {
    PATH: process.env.PATH, TARGET: 'cli',
    CLI_AGENTIC_API_URL: `${base}/v1`, CLI_GENIE_URL: `${base}/genie`, CLI_KALTURA_API_ENDPOINT: `${base}/ovp`,
    CLI_PARTNER_ID_1: '123', CLI_ADMIN_SECRET_1: SECRET,
  };
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: root });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      assert.ok(!(stdout + stderr).includes(SECRET), 'the admin secret is never printed');
      ok({ code, stdout, stderr });
    });
  });
}

test('exit 1 on an error finding; text output names the agent and the fix', async () => {
  const r = await run([]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /\[ERROR\] asr_language_mismatch \(agent a1, intellect 10\)/);
  assert.match(r.stdout, /\n {2}fix: /);
  assert.match(r.stdout, /target cli: 1 error, 0 warn, 0 info\./);
});

test('exit 0 and a clean summary when the agent is right', async () => {
  const r = await run([], { set: { asr: { language: 'he', provider: 'kaltura' } } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 error, 0 warn, 0 info/);
});

test('--fail-on warn fails on a warn finding that the default lets pass', async () => {
  const set = { forced: undefined }; // no forced language, a Hebrew voice, ASR en: a warn
  assert.equal((await run([], { set })).code, 0);
  assert.equal((await run(['--fail-on', 'warn'], { set })).code, 1);
});

test('--json prints schemaVersion, target and the report', async () => {
  const r = await run(['--json']);
  assert.equal(r.code, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.target, 'cli');
  assert.deepEqual(doc.report.findings.map((f) => f.code), ['asr_language_mismatch']);
  assert.equal(doc.report.findings[0].autofix.to, 'he');
  assert.equal(doc.fix, undefined);
});

test('--format markdown prints a table', async () => {
  const r = await run(['--format', 'markdown']);
  assert.match(r.stdout, /^# Doctor report: cli/);
  assert.match(r.stdout, /\| error \| `asr_language_mismatch` \| agent a1, intellect 10 \|/);
});

test('--ignore-file hides findings and counts them; the exit code follows what is left', async () => {
  const file = join(tmp, 'ignore.json');
  writeFileSync(file, JSON.stringify([{ code: 'asr_language_mismatch', agentId: 'a1' }]));
  const r = await run(['--json', '--ignore-file', file]);
  assert.equal(r.code, 0, r.stderr);
  const { report } = JSON.parse(r.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.suppressed, 1);
  writeFileSync(file, JSON.stringify({ ignore: [{ code: 'asr_language_mismatch' }] }));
  assert.equal((await run(['--ignore-file', file])).code, 0, 'the { ignore } wrapper works');
});

test('--only and --skip pick checks', async () => {
  assert.equal((await run(['--skip', 'language'])).code, 0);
  assert.equal((await run(['--only', 'orphans'])).code, 0);
  assert.equal((await run(['--only', 'language'])).code, 1);
});

test('--fix is a dry run: it prints the plan and writes nothing', async () => {
  const r = await run(['--fix']);
  assert.equal(r.code, 1, 'the exit code comes from the report');
  assert.match(r.stdout, /fixes \(dry run, nothing written\):\n {2}planned: agent a1 asr\.language en -> he/);
  assert.equal(state.writes.length, 0);
});

test('--fix --apply --code writes the fix', async () => {
  const r = await run(['--fix', '--apply', '--code', 'asr_language_mismatch', '--json']);
  assert.equal(r.code, 1);
  assert.deepEqual(state.writes, [{ agentId: 'a1', asr: { language: 'he', provider: 'kaltura' } }]);
  assert.equal(JSON.parse(r.stdout).fix.results[0].status, 'applied');
  assert.equal((await run([], { set: { asr: state.asr } })).code, 0, 'a second run is clean');
});

test('exit 2 on a usage error, and on a failed token request', async () => {
  const file = join(tmp, 'bad.json');
  writeFileSync(file, '{"nope":1}');
  const bad = [['--nope'], ['--fail-on', 'bad'], ['--format', 'html'], ['--json', '--format', 'markdown'], ['--agent', ' '], ['--apply'], ['--fix', '--apply'], ['--code', 'x'], ['--ignore-file', file], ['--ignore-file', join(tmp, 'missing.json')], ['extra']];
  for (const args of bad) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /usage: node scripts\/doctor\.mjs/);
  }
  assert.equal(state.requests.length, 0, 'usage errors send no request');
  const denied = await run([], { set: { mintOk: false } });
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /doctor failed/);
});

test('--help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: node scripts\/doctor\.mjs/);
});

const RULE = { id: 'r1', systemName: 'insights', status: 'active', eventType: 'session_ended', objectType: 'thread', eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: 'a1' }], action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1'] } };

test('--probe sends one unstored message and prints timings and the limits', async () => {
  const r = await run(['--agent', 'a1', '--only', 'orphans', '--probe', '--message', 'Hi']);
  assert.match(r.stdout, /probe, agent a1:/);
  assert.match(r.stdout, /first segment \d+ ms, first text \d+ ms, total \d+ ms/);
  assert.match(r.stdout, /0 tool segment\(s\), 11 reply characters/);
  assert.match(r.stdout, /no speech recognition/);
  assert.equal(r.code, 0);
  assert.deepEqual(state.converseBodies, [{ userMessage: 'Hi', sse: false, add_message_in_db: false }]);
});

test('--probe stops and lists the rules that match the agent, exit 2, nothing sent', async () => {
  const r = await run(['--agent', 'a1', '--only', 'orphans', '--probe'], { set: { rules: [RULE] } });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /1 active lifecycle rule\(s\) run for this agent: insights/);
  assert.match(r.stdout, /not run/);
  assert.deepEqual(state.converseBodies, []);
});

test('--probe --allow-side-effects runs despite the rules', async () => {
  const r = await run(['--agent', 'a1', '--only', 'orphans', '--probe', '--allow-side-effects'], { set: { rules: [RULE] } });
  assert.equal(r.code, 0);
  assert.equal(state.converseBodies.length, 1);
});

test('--probe with --json adds a probe object', async () => {
  const r = await run(['--agent', 'a1', '--only', 'orphans', '--probe', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.probe.ran, true);
  assert.equal(out.probe.reply.replyChars, 11);
});

test('probe flags are checked before any request', async () => {
  for (const args of [['--probe'], ['--probe', '--agent', 'a1', '--agent', 'a2'], ['--message', 'x'], ['--allow-side-effects'], ['--probe', '--agent', 'a1', '--message', ' ']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /usage:/);
  }
  assert.deepEqual(state.requests, []);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/lifecycle-audit.mjs` end to end: flags and exit codes, against a
 * local HTTP server that stands in for the three backends. No real network.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = resolve(root, 'scripts/lifecycle-audit.mjs');
const SECRET = 'cli-test-secret-value-9f3';

const scope = (...ids) => (ids.length === 1
  ? [{ field: 'object.agent_id', operator: 'eq', value: ids[0] }]
  : [{ field: 'object.agent_id', operator: 'in', value: ids }]);
const insightRule = (over = {}) => ({
  id: 'r1', systemName: 'insights', status: 'active', eventType: 'session_ended', objectType: 'thread',
  eventConditions: scope('a1'), action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1'] }, ...over,
});

/** What the fake backends serve. Each test sets it before running the CLI. */
const state = { rules: [], settings: [{ id: 's1', key: 'TOPIC', status: 'active' }], agents: [{ agentId: 'a1' }, { agentId: 'a2' }], mintOk: true, requests: [] };

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    state.requests.push(`${req.method} ${path}`);
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const page = (all) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const { offset = 0, limit = 30 } = JSON.parse(b || '{}').pager ?? {}; send({ objects: all.slice(offset, offset + limit), totalCount: all.length }); }); };
    if (path.endsWith('/session/action/start')) { req.resume(); return send(state.mintOk ? `djJ8${'A'.repeat(40)}` : { objectType: 'KalturaAPIException', message: 'denied', code: 'DENIED' }); }
    if (path.endsWith('/lifecycle/list')) return page(state.rules);
    if (path.endsWith('/insight-settings/list')) return page(state.settings);
    if (path.endsWith('/agent/list')) return page(state.agents);
    req.resume();
    return send({ message: 'not found' }, 404);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); }));

function run(args, { env = {}, set } = {}) {
  Object.assign(state, { rules: [], settings: [{ id: 's1', key: 'TOPIC', status: 'active' }], agents: [{ agentId: 'a1' }, { agentId: 'a2' }], mintOk: true, requests: [] }, set);
  const childEnv = {
    PATH: process.env.PATH, TARGET: 'cli',
    CLI_AGENTIC_API_URL: `${base}/v1`, CLI_GENIE_URL: `${base}/genie`, CLI_KALTURA_API_ENDPOINT: `${base}/ovp`,
    CLI_PARTNER_ID_1: '123', CLI_ADMIN_SECRET_1: SECRET, ...env,
  };
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv, cwd: root });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      assert.ok(!(stdout + stderr).includes(SECRET), 'the admin secret is never printed');
      ok({ code, stdout, stderr });
    });
  });
}

test('exit 0 and a clean summary when nothing is wrong', async () => {
  const r = await run([], { set: { rules: [insightRule()] } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /target cli: 0 error, 0 warn, 0 info/);
  assert.match(r.stdout, /checked: rules 1/);
});

test('exit 1 on an error finding, and the text output names the rule and the fix', async () => {
  const email = insightRule({ eventType: 'session_ended', action: { actionType: 'sendInsightEmail', recipients: ['u'], presetType: 'conversationInsightExample' } });
  const r = await run([], { set: { rules: [email] } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\[ERROR\] email_on_session_ended \(rule r1, insights\)/);
  assert.match(r.stdout, /\n {2}fix: /);
});

test('--fail-on picks the level that fails the run', async () => {
  const set = { rules: [insightRule({ eventConditions: [] })] }; // unscoped_rule is a warn
  assert.equal((await run([], { set })).code, 0, 'default is error');
  assert.equal((await run(['--fail-on', 'error'], { set })).code, 0);
  assert.equal((await run(['--fail-on', 'warn'], { set })).code, 1);
});

test('--json prints one JSON document with the report', async () => {
  const r = await run(['--json'], { set: { rules: [insightRule({ eventConditions: [] })] } });
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.target, 'cli');
  assert.deepEqual(doc.findings.map((f) => f.code), ['unscoped_rule']);
  assert.deepEqual(doc.summary, { error: 0, warn: 1, info: 0 });
  assert.deepEqual(doc.skipped, []);
});

test('--agent limits the check to rules that run for that agent', async () => {
  const rules = [insightRule({ id: 'x1', eventConditions: scope('a1', 'ghost') }), insightRule({ id: 'x2', eventConditions: scope('a2', 'ghost2') })];
  const r = await run(['--json', '--agent', 'a1'], { set: { rules } });
  assert.deepEqual(JSON.parse(r.stdout).findings.map((f) => f.ruleId), ['x1']);
  const both = await run(['--json', '--agent', 'a1', '--agent', 'a2'], { set: { rules } });
  assert.deepEqual(JSON.parse(both.stdout).findings.map((f) => f.ruleId).sort(), ['x1', 'x2']);
});

test('--doctor adds the intellect and orphan checks', async () => {
  const r = await run(['--json', '--doctor'], { set: { rules: [insightRule()], settings: [{ id: 's1', key: 'TOPIC', status: 'active' }, { id: 's9', key: 'X', status: 'active' }] } });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.findings.map((f) => f.code), ['orphan_insight_setting']);
  assert.equal(doc.checked.agentIntellects, 0);
  assert.ok(doc.skipped.includes('templates'), 'a target with no messaging URL skips templates');
});

test('a rule that pins a template skips the template checks on a target with no messaging URL', async () => {
  const email = insightRule({ eventType: 'analysis_updated', eventConditions: [...scope('a1'), { field: 'changed_keys', operator: 'has_any', value: ['SUMMARY'] }], action: { actionType: 'sendInsightEmail', recipients: ['u'], templateId: 'tpl' } });
  const r = await run([], { set: { rules: [email] } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /skipped: templates/);
});

test('exit 2 on a usage error', async () => {
  for (const args of [['--nope'], ['--fail-on', 'bad'], ['--fail-on'], ['--agent'], ['--agent', ' '], ['extra']]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node scripts\/lifecycle-audit\.mjs/);
    assert.equal(state.requests.length, 0, 'no request before the flags are valid');
  }
});

test('--help exits 0 and prints the usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: node scripts\/lifecycle-audit\.mjs/);
});

test('exit 2 when credentials are missing, naming the variables and no values', async () => {
  const r = await run([], { env: { CLI_ADMIN_SECRET_1: '', CLI_PARTNER_ID_1: '' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /CLI_PARTNER_ID_1/);
});

test('exit 2 when the admin token cannot be minted', async () => {
  const r = await run([], { set: { mintOk: false } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /audit failed/);
  assert.equal(state.requests.some((p) => p.endsWith('/lifecycle/list')), false);
});

test('exit 2 on an unknown target name', async () => {
  const r = await run([], { env: { TARGET: 'Not A Target' } });
  assert.equal(r.code, 2);
});

test('the CLI never writes: only list calls reach the backends', async () => {
  await run(['--doctor'], { set: { rules: [insightRule()] } });
  for (const p of state.requests) assert.match(p, /(\/start|\/list|\/get)$/);
});

test('every live-verify script that builds a Management client goes through resolveTarget', () => {
  const dir = resolve(root, 'scripts');
  const files = readdirSync(dir).filter((f) => /^live-verify.*\.mjs$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    if (/new Management\(/.test(src)) assert.match(src, /resolveTarget|managementFor/, `${f} must pick its backend through scripts/lib/target.mjs`);
  }
  assert.match(readFileSync(resolve(dir, 'lifecycle-audit.mjs'), 'utf8'), /resolveTarget\(/);
  assert.match(readFileSync(resolve(dir, 'live-verify-lifecycle-audit.mjs'), 'utf8'), /resolveTarget\(/);
});

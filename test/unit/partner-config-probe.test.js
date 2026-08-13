import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPartnerConfigError, probePartnerConfigRoute } from '../../src/management/partner-config-probe.js';

/**
 * management/partner-config-probe.js — the shared classifier + prober that
 * `Intellects#brainConfigAvailable`/`#setBrainConfig` and
 * `Knowledge#linkAvailable`/`#linkCategory` all delegate to, so a 403/404
 * against `partner-config/*` reads the same `{code, reason}` everywhere.
 */

test('classifyPartnerConfigError maps status 403 to forbidden with a deployment-gated reason', () => {
  const { code, reason } = classifyPartnerConfigError({ status: 403 });
  assert.equal(code, 'forbidden');
  assert.match(reason, /higher privilege/i);
});

test('classifyPartnerConfigError maps status 404 to not_deployed', () => {
  const { code, reason } = classifyPartnerConfigError({ status: 404 });
  assert.equal(code, 'not_deployed');
  assert.match(reason, /not on this deployment/i);
});

test('classifyPartnerConfigError falls back to the error\'s own code, then detail/message, for anything else', () => {
  const withCode = classifyPartnerConfigError({ status: 500, code: 'server_error', detail: 'boom' });
  assert.equal(withCode.code, 'server_error');
  assert.equal(withCode.reason, 'boom');

  const noCode = classifyPartnerConfigError({ status: 500, message: 'network blip' });
  assert.equal(noCode.code, 'error');
  assert.equal(noCode.reason, 'network blip');
});

test('classifyPartnerConfigError never throws on null/undefined/non-error input', () => {
  assert.equal(classifyPartnerConfigError(null).code, 'error');
  assert.equal(classifyPartnerConfigError(undefined).code, 'error');
  assert.equal(classifyPartnerConfigError({}).code, 'error');
});

test('probePartnerConfigRoute returns {available:true, reason} on a successful genie call', async () => {
  const ctx = { genie: async () => ({ data: { id: 0, config: {} } }) };
  const result = await probePartnerConfigRoute(ctx, 'ks', 'route reachable');
  assert.deepEqual(result, { available: true, reason: 'route reachable' });
});

test('probePartnerConfigRoute never throws — catches and classifies the genie call\'s rejection', async () => {
  const ctx = { genie: async () => { throw { status: 403 }; } };
  const result = await probePartnerConfigRoute(ctx, 'ks', 'route reachable');
  assert.equal(result.available, false);
  assert.equal(result.code, 'forbidden');

  const ctx404 = { genie: async () => { throw { status: 404 }; } };
  const result404 = await probePartnerConfigRoute(ctx404, 'ks', 'route reachable');
  assert.equal(result404.available, false);
  assert.equal(result404.code, 'not_deployed');
});

test('probePartnerConfigRoute calls genie with partner-config/get id:0 and the given ks', async () => {
  const calls = [];
  const ctx = { genie: async (...args) => { calls.push(args); return { data: {} }; } };
  await probePartnerConfigRoute(ctx, 'my-ks', 'ok');
  assert.deepEqual(calls, [['partner-config/get', { id: 0 }, 'my-ks']]);
});

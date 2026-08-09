import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrainConfigPatch } from '../../src/management/intellects.js';
import { buildUserPropertiesForms } from '../../src/management/intellect-config.js';

/**
 * PURE unit tests for the G1 (intellects + intellect-config) validation/merge
 * surface: brain-config patch builder + user-properties builder. No network.
 */

// ─────────────────────────── buildBrainConfigPatch ───────────────────────────

test('buildBrainConfigPatch maps the verified tier to snake keys + lists applied', () => {
  const { config, applied } = buildBrainConfigPatch({
    agentLlm: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    agentFastLlm: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    rateLimits: { perMinute: 250, perHour: 2500 },
    anonymousRateLimits: { perMinute: 30, perHour: 200 },
  });
  assert.equal(config.agent_llm, 'us.anthropic.claude-sonnet-4-20250514-v1:0');
  assert.equal(config.agent_fast_llm, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(config.rate_limit_per_minute, 250);
  assert.equal(config.rate_limit_per_hour, 2500);
  assert.equal(config.anonymous_rate_limit_per_minute, 30);
  assert.equal(config.anonymous_rate_limit_per_hour, 200);
  for (const k of ['agent_llm', 'agent_fast_llm', 'rate_limit_per_minute', 'rate_limit_per_hour', 'anonymous_rate_limit_per_minute', 'anonymous_rate_limit_per_hour']) {
    assert.ok(applied.includes(k), `applied lists ${k}`);
  }
});

test('buildBrainConfigPatch: partial fill writes ONLY the supplied key (merge/PATCH proof)', () => {
  const { config, applied } = buildBrainConfigPatch({ agentLlm: 'us.x' });
  assert.deepEqual(Object.keys(config), ['agent_llm']);
  assert.deepEqual(applied, ['agent_llm']);
});

test('buildBrainConfigPatch maps the unverified Class-B tier + web search', () => {
  const { config, applied } = buildBrainConfigPatch({
    agentAvatarLlm: 'models/gemini-3.1-flash-lite',
    runQuotaCheck: true,
    webSearch: { includeDomains: ['kaltura.com'], includeAnswer: 'advanced', searchDepth: 'advanced', maxResults: 8 },
  });
  assert.equal(config.agent_avatar_llm, 'models/gemini-3.1-flash-lite');
  assert.equal(config.run_quota_check, true);
  assert.deepEqual(config.web_search_config, { include_domains: ['kaltura.com'], include_answer: 'advanced', search_depth: 'advanced', max_results: 8 });
  assert.ok(applied.includes('web_search_config') && applied.includes('agent_avatar_llm') && applied.includes('run_quota_check'));
});

test('buildBrainConfigPatch: webSearch defaults search_depth=ultra-fast + max_results=5', () => {
  const { config } = buildBrainConfigPatch({ webSearch: {} });
  assert.equal(config.web_search_config.search_depth, 'ultra-fast');
  assert.equal(config.web_search_config.max_results, 5);
});

test('buildBrainConfigPatch: empty config → bad_request', () => {
  assert.throws(() => buildBrainConfigPatch({}), (e) => e.code === 'bad_request');
});

test('buildBrainConfigPatch: bad searchDepth → bad_request naming the key', () => {
  assert.throws(() => buildBrainConfigPatch({ webSearch: { searchDepth: 'turbo' } }), (e) => e.code === 'bad_request' && /searchDepth/.test(e.detail));
});

test('buildBrainConfigPatch: bad includeAnswer → bad_request', () => {
  assert.throws(() => buildBrainConfigPatch({ webSearch: { includeAnswer: 'full' } }), (e) => e.code === 'bad_request');
});

test('buildBrainConfigPatch: negative rate limit → bad_request', () => {
  assert.throws(() => buildBrainConfigPatch({ rateLimits: { perMinute: -1 } }), (e) => e.code === 'bad_request');
});

test('buildBrainConfigPatch: maxResults must be > 0', () => {
  assert.throws(() => buildBrainConfigPatch({ webSearch: { maxResults: 0 } }), (e) => e.code === 'bad_request');
});

test('buildBrainConfigPatch: anonymous 0 limit is ALLOWED (blocks all anon, a footgun, not an error)', () => {
  const { config } = buildBrainConfigPatch({ anonymousRateLimits: { perMinute: 0 } });
  assert.equal(config.anonymous_rate_limit_per_minute, 0);
});

test('buildBrainConfigPatch: empty model-id string → bad_request', () => {
  assert.throws(() => buildBrainConfigPatch({ agentLlm: '   ' }), (e) => e.code === 'bad_request');
});

// ───────────────────────── buildUserPropertiesForms ─────────────────────────

test('buildUserPropertiesForms builds the LIST wire shape and accepts callStage or call_stage', () => {
  // The server 422s a bare dict ("Input should be a valid list") — the wire shape
  // MUST be a list of forms, verified live on a scratch intellect (issue #33 A).
  const a = buildUserPropertiesForms([{ callStage: 'middle', properties: [{ key: 'email', type: 'str' }] }]);
  assert.deepEqual(a, [{ call_stage: 'middle', properties: [{ key: 'email', type: 'str' }] }]);
  const b = buildUserPropertiesForms([{ call_stage: 'end', properties: [{ key: 'name' }] }]);
  assert.equal(b[0].call_stage, 'end');
  assert.equal(b[0].properties[0].type, 'str'); // defaulted
});

test('buildUserPropertiesForms wraps a single form object into a one-element list', () => {
  const a = buildUserPropertiesForms({ callStage: 'start', properties: [{ key: 'email' }] });
  assert.ok(Array.isArray(a));
  assert.equal(a.length, 1);
  assert.equal(a[0].call_stage, 'start');
});

test('buildUserPropertiesForms builds multiple forms (one per call stage)', () => {
  const a = buildUserPropertiesForms([
    { callStage: 'start', properties: [{ key: 'name' }] },
    { callStage: 'end', properties: [{ key: 'email', type: 'str' }] },
  ]);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((f) => f.call_stage), ['start', 'end']);
});

test('buildUserPropertiesForms: bad stage → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'whenever', properties: [{ key: 'x' }] }]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: empty forms list → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: empty properties → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'start', properties: [] }]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: bad property type → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'start', properties: [{ key: 'x', type: 'number' }] }]), (e) => e.code === 'bad_request');
});

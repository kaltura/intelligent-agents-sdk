import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  CAPABILITY_STATE,
  CAPABILITY_DEFAULTS,
  CAPABILITY_INFO,
  assertCapability,
  assertCapabilityState,
  validateCapabilities,
  mergeCapabilityWrite,
  resolveCapabilities,
} from '../../src/management/capabilities.js';

/** Typed capability set + pure 3-level resolver with DISABLED veto. */

const OFF_DEFAULTS = [
  'avatar', 'avatar_filler', 'avatar_show_content', 'video_gallery',
  'external_video', 'show_link', 'use_web_search', 'screen_share_analysis',
  'think_process',
];

// ── const tables ────────────────────────────────────────────────────────────

test('CAPABILITIES is the frozen 16-name set in canonical order', () => {
  assert.equal(CAPABILITIES.length, 16);
  assert.ok(Object.isFrozen(CAPABILITIES));
  assert.deepEqual([...CAPABILITIES], [
    'use_knowledge_base', 'use_content_search', 'use_get_entry_content',
    'generate_followup_questions', 'include_sources', 'use_related_files',
    'video_gallery', 'external_video', 'show_link', 'avatar', 'avatar_filler',
    'avatar_show_content', 'kaltura_genie_experiences', 'use_web_search',
    'screen_share_analysis', 'think_process',
  ]);
});

test('CAPABILITY_STATE is the frozen on/off/disabled enum', () => {
  assert.ok(Object.isFrozen(CAPABILITY_STATE));
  assert.deepEqual(CAPABILITY_STATE, { ON: 'on', OFF: 'off', DISABLED: 'disabled' });
});

test('CAPABILITY_DEFAULTS: 9 OFF, 7 ON (kaltura_genie_experiences ON); frozen snapshot', () => {
  assert.ok(Object.isFrozen(CAPABILITY_DEFAULTS));
  const off = CAPABILITIES.filter((c) => CAPABILITY_DEFAULTS[c] === 'off');
  const on = CAPABILITIES.filter((c) => CAPABILITY_DEFAULTS[c] === 'on');
  assert.deepEqual(off.sort(), [...OFF_DEFAULTS].sort());
  assert.equal(on.length, 7);
  assert.equal(CAPABILITY_DEFAULTS.kaltura_genie_experiences, 'on');
  assert.equal(CAPABILITY_DEFAULTS.think_process, 'off');
  // every capability has a default
  for (const c of CAPABILITIES) assert.ok(CAPABILITY_DEFAULTS[c] === 'on' || CAPABILITY_DEFAULTS[c] === 'off');
});

test('CAPABILITY_INFO covers all 16 with valid kind + defaultState matching CAPABILITY_DEFAULTS', () => {
  const kinds = new Set(['tool', 'segment', 'mode', 'prompt']);
  assert.deepEqual(Object.keys(CAPABILITY_INFO).sort(), [...CAPABILITIES].sort());
  for (const c of CAPABILITIES) {
    const info = CAPABILITY_INFO[c];
    assert.ok(kinds.has(info.kind), `${c} kind`);
    assert.equal(info.defaultState, CAPABILITY_DEFAULTS[c], `${c} defaultState`);
    assert.equal(typeof info.summary, 'string');
    assert.ok(info.summary.length > 0);
  }
  // segment caps carry a runtime name
  assert.equal(CAPABILITY_INFO.show_link.runtime, 'show-link');
  assert.equal(CAPABILITY_INFO.generate_followup_questions.runtime, 'followups');
  assert.equal(CAPABILITY_INFO.think_process.kind, 'segment');
  assert.equal(CAPABILITY_INFO.think_process.runtime, 'think');
});

test('CAPABILITY_INFO summaries name no internal-only backend fields', () => {
  const all = Object.values(CAPABILITY_INFO).map((i) => i.summary).join('\n');
  for (const s of ['web_search_config', 'agent_avatar_llm', 'agent_llm', 'agent_fast_llm', 'rate_limit', 'run_quota_check', 'avatar_config']) {
    assert.ok(!all.includes(s), `summary mentions ${s}`);
  }
});

// ── assertCapability / assertCapabilityState ─────────────────────────────────

test('assertCapability accepts known, throws unknown_capability on typo', () => {
  assert.equal(assertCapability('avatar'), 'avatar');
  assert.throws(() => assertCapability('avatarr'), (e) => e.code === 'unknown_capability');
  assert.throws(() => assertCapability(42), (e) => e.code === 'unknown_capability');
  assert.throws(() => assertCapability(undefined), (e) => e.code === 'unknown_capability');
});

test('think_process is a known capability (accepted pre-network)', () => {
  assert.equal(assertCapability('think_process'), 'think_process');
  assert.deepEqual(validateCapabilities({ think_process: 'on' }), { think_process: 'on' });
});

test('assertCapabilityState accepts on/off/disabled, rejects others', () => {
  assert.equal(assertCapabilityState('on'), 'on');
  assert.equal(assertCapabilityState('disabled'), 'disabled');
  assert.throws(() => assertCapabilityState('enabled'), (e) => e.code === 'bad_request');
  assert.throws(() => assertCapabilityState(true), (e) => e.code === 'bad_request');
});

// ── validateCapabilities ─────────────────────────────────────────────────────

test('validateCapabilities passes a good dict, throws on unknown key', () => {
  const good = { avatar: 'on', use_web_search: 'disabled' };
  assert.equal(validateCapabilities(good), good);
  assert.throws(() => validateCapabilities({ nope: 'on' }), (e) => e.code === 'unknown_capability');
});

test('validateCapabilities throws on bad state and on non-object', () => {
  assert.throws(() => validateCapabilities({ avatar: 'yes' }), (e) => e.code === 'bad_request');
  assert.throws(() => validateCapabilities(null), (e) => e.code === 'bad_request');
  assert.throws(() => validateCapabilities([]), (e) => e.code === 'bad_request');
  assert.throws(() => validateCapabilities('avatar'), (e) => e.code === 'bad_request');
});

// ── mergeCapabilityWrite (full-replace dict semantics) ───────────────────────

test('mergeCapabilityWrite overlays patch on current, drops nothing, mutates neither', () => {
  const current = { use_knowledge_base: 'on', avatar: 'off', show_link: 'on' };
  const patch = { avatar: 'on' };
  const merged = mergeCapabilityWrite(current, patch);
  assert.deepEqual(merged, { use_knowledge_base: 'on', avatar: 'on', show_link: 'on' });
  // siblings preserved (the whole point — capabilities is full-replace on the wire)
  assert.equal(merged.use_knowledge_base, 'on');
  assert.equal(merged.show_link, 'on');
  // no mutation
  assert.deepEqual(current, { use_knowledge_base: 'on', avatar: 'off', show_link: 'on' });
  assert.deepEqual(patch, { avatar: 'on' });
});

test('mergeCapabilityWrite treats null/undefined current as empty dict', () => {
  assert.deepEqual(mergeCapabilityWrite(null, { avatar: 'on' }), { avatar: 'on' });
  assert.deepEqual(mergeCapabilityWrite(undefined, { avatar: 'on' }), { avatar: 'on' });
});

test('mergeCapabilityWrite validates patch strictly; unknown current keys pass through', () => {
  // unknown keys in the CURRENT dict (from a newer server snapshot) pass through unchanged
  // so the SDK does not make capabilities immutable on intellects that have server-added capabilities
  assert.deepEqual(mergeCapabilityWrite({ bogus: 'on' }, { avatar: 'on' }), { bogus: 'on', avatar: 'on' });
  // unknown keys in the PATCH (caller-controlled) still throw
  assert.throws(() => mergeCapabilityWrite({ avatar: 'on' }, { bogus: 'on' }), (e) => e.code === 'unknown_capability');
  // invalid state values in the patch still throw
  assert.throws(() => mergeCapabilityWrite({ avatar: 'on' }, { avatar: 'maybe' }), (e) => e.code === 'bad_request');
});

// ── resolveCapabilities: precedence truth table ──────────────────────────────

test('resolve with no layers => every capability falls to default, resolvedFrom env (default snapshot)', () => {
  const { capabilities, _meta } = resolveCapabilities();
  assert.equal(Object.keys(capabilities).length, CAPABILITIES.length);
  assert.equal(Object.keys(capabilities).length, 16);
  for (const c of CAPABILITIES) {
    assert.equal(capabilities[c].state, CAPABILITY_DEFAULTS[c], `${c}`);
    assert.equal(capabilities[c].vetoed, false);
  }
  // env layer defaults to the snapshot, so resolvedFrom is 'env' (snapshot supplies it)
  assert.equal(capabilities.avatar.resolvedFrom, 'env');
  assert.ok(_meta.generatedAt);
  assert.equal(_meta.source, 'sdk/capabilities/resolve');
});

test('request beats partner_config beats env beats default', () => {
  const { capabilities } = resolveCapabilities({
    env: { avatar: 'off' },
    partnerConfig: { avatar: 'on' },
    request: { avatar: 'off' },
  });
  assert.equal(capabilities.avatar.state, 'off');
  assert.equal(capabilities.avatar.resolvedFrom, 'request');

  // partner_config wins when no request
  const r2 = resolveCapabilities({ env: { avatar: 'off' }, partnerConfig: { avatar: 'on' } });
  assert.equal(r2.capabilities.avatar.state, 'on');
  assert.equal(r2.capabilities.avatar.resolvedFrom, 'partner_config');

  // env wins when no request/partner_config
  const r3 = resolveCapabilities({ env: { avatar: 'on' } });
  assert.equal(r3.capabilities.avatar.state, 'on');
  assert.equal(r3.capabilities.avatar.resolvedFrom, 'env');
});

test('absent everywhere (empty env) => falls to CAPABILITY_DEFAULTS, resolvedFrom default', () => {
  // pass an env missing this key to force the default tier
  const { capabilities } = resolveCapabilities({ env: { avatar: 'on' } });
  // use_web_search not in this env, no pc/request => default (off)
  assert.equal(capabilities.use_web_search.state, 'off');
  assert.equal(capabilities.use_web_search.resolvedFrom, 'default');
});

// ── DISABLED veto truth table ────────────────────────────────────────────────

test('env DISABLED vetoes an on request => off, vetoed:true, resolvedFrom disabled_veto', () => {
  const { capabilities } = resolveCapabilities({
    env: { external_video: 'disabled' },
    request: { external_video: 'on' },
  });
  assert.equal(capabilities.external_video.state, 'off');
  assert.equal(capabilities.external_video.vetoed, true);
  assert.equal(capabilities.external_video.resolvedFrom, 'disabled_veto');
});

test('partner_config DISABLED vetoes an on request', () => {
  const { capabilities } = resolveCapabilities({
    partnerConfig: { external_video: 'disabled' },
    request: { external_video: 'on' },
  });
  assert.equal(capabilities.external_video.state, 'off');
  assert.equal(capabilities.external_video.vetoed, true);
});

test('a request DISABLED is NOT a veto (only env/partner_config veto)', () => {
  const { capabilities } = resolveCapabilities({
    env: { avatar: 'on' },
    request: { avatar: 'disabled' },
  });
  // request disabled is a normal request value: it wins precedence but does not veto
  assert.equal(capabilities.avatar.state, 'disabled');
  assert.equal(capabilities.avatar.vetoed, false);
  assert.equal(capabilities.avatar.resolvedFrom, 'request');
});

test('veto holds even when request says on AND partner_config says on, env disabled', () => {
  const { capabilities } = resolveCapabilities({
    env: { show_link: 'disabled' },
    partnerConfig: { show_link: 'on' },
    request: { show_link: 'on' },
  });
  assert.equal(capabilities.show_link.state, 'off');
  assert.equal(capabilities.show_link.vetoed, true);
});

// ── use_web_search resolves like every other capability ──────────────────────

test('use_web_search carries no inferred flag and resolves from its explicit layers only', () => {
  const { capabilities } = resolveCapabilities();
  assert.equal('inferred' in capabilities.use_web_search, false);
  assert.equal(capabilities.use_web_search.state, 'off');
  assert.equal(capabilities.use_web_search.resolvedFrom, 'env');
  const on = resolveCapabilities({ partnerConfig: { use_web_search: 'on' } }).capabilities.use_web_search;
  assert.equal(on.state, 'on');
  assert.equal(on.resolvedFrom, 'partner_config');
});

test('every resolved entry has exactly {state, resolvedFrom, vetoed, layers}', () => {
  const { capabilities } = resolveCapabilities();
  for (const c of CAPABILITIES) {
    assert.deepEqual(Object.keys(capabilities[c]).sort(), ['layers', 'resolvedFrom', 'state', 'vetoed'], c);
  }
});

// ── resolver validation + receipt ────────────────────────────────────────────

test('resolveCapabilities validates caller layers (bad key/state => throw, no result)', () => {
  assert.throws(() => resolveCapabilities({ request: { bogus: 'on' } }), (e) => e.code === 'unknown_capability');
  assert.throws(() => resolveCapabilities({ env: { avatar: 'maybe' } }), (e) => e.code === 'bad_request');
});

test('layers field records raw inputs seen for each capability', () => {
  const { capabilities } = resolveCapabilities({
    env: { avatar: 'off' },
    partnerConfig: { avatar: 'on' },
    request: { avatar: 'off' },
  });
  assert.deepEqual(capabilities.avatar.layers, {
    env: 'off', partnerConfig: 'on', request: 'off', default: 'off',
  });
});

test('_meta carries partnerId when provided', () => {
  const { _meta } = resolveCapabilities({ partnerId: 12345 });
  assert.equal(_meta.partnerId, '12345');
  assert.match(_meta.scope, /DISABLED veto/);
});

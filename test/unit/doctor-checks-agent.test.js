import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asrLanguage, avatarCapability, avatarReferences, avatarShared, intellectReference, maxConversation,
  openingPhraseDuplicate, openingPhraseLanguage, voiceLanguageDefault, voiceReplyLanguage,
} from '../../src/management/doctor/checks/agent.js';
import { CHECKS, DOCTOR_CODES, runChecks, selectChecks } from '../../src/management/doctor/checks/index.js';
import { DEFAULT_THRESHOLDS } from '../../src/management/doctor/model.js';

/** Pure checks over hand-built views. No network, no fakes. */

// Live shape: name and language sit under attributes.voice. Presets carry the `preset` tag.
const voice = (language, extra = {}) => ({ id: `v-${language}`, state: 'found', item: { itemId: `v-${language}`, adminTags: ['preset'], attributes: { voice: { name: `Voice ${language}`, language } }, ...extra } });
const avatar = (id, v, extra = {}) => ({ id, state: 'found', avatar: { id, voice: { id: v?.id }, visual: { id: 'vis1' }, ...extra }, voice: v, visual: { id: 'vis1', state: 'found', item: { itemId: 'vis1' } } });
const view = ({ agent = {}, intellect = { id: 10, type: 'brain' }, avatars = [] } = {}) => ({
  agentId: 'a1', agent: { agentId: 'a1', avatarIds: avatars.map((a) => a.id), asr: { language: 'en', provider: 'kaltura' }, ...agent },
  configId: 10, intellectState: intellect ? 'found' : 'missing', intellect: intellect ?? undefined, avatars,
});
const run = (check, v) => check.run(v, DEFAULT_THRESHOLDS);
const codes = (findings) => findings.map((f) => `${f.severity}:${f.code}`);

// The incident: ASR left at the default `en`, a Hebrew voice, replies in Hebrew.
const incident = () => view({ intellect: { id: 10, type: 'brain', force_language: 'Hebrew' }, avatars: [avatar('av1', voice('he'))] });

test('asr_language_mismatch: the incident agent (ASR en, Hebrew voice, replies in Hebrew) is an error that names the fix', () => {
  const f = run(asrLanguage, incident());
  assert.deepEqual(codes(f), ['error:asr_language_mismatch']);
  assert.equal(f[0].agentId, 'a1');
  assert.equal(f[0].field, 'asr.language');
  assert.match(f[0].fix, /asr: \{ language: 'he', provider: 'kaltura' \}/);
});

test('asr_language_mismatch: keeps the current ASR provider in the fix', () => {
  const v = incident();
  v.agent.asr = { language: 'en', provider: 'elevenlabs' };
  assert.match(run(asrLanguage, v)[0].fix, /provider: 'elevenlabs'/);
});

test('asr_language_mismatch: with no forced language, a voice that differs is only a warn', () => {
  const v = view({ avatars: [avatar('av1', voice('he'))] });
  assert.deepEqual(codes(run(asrLanguage, v)), ['warn:asr_language_mismatch']);
});

test('asr_language_mismatch: silent when ASR, forced language and voice agree, or ASR is unknown', () => {
  assert.deepEqual(run(asrLanguage, view({ agent: { asr: { language: 'he', provider: 'kaltura' } }, intellect: { id: 10, type: 'brain', force_language: 'Hebrew' }, avatars: [avatar('av1', voice('he'))] })), []);
  assert.deepEqual(run(asrLanguage, view({ agent: { asr: { language: 'iw' } }, intellect: { id: 10, type: 'brain', force_language: 'he' }, avatars: [] })), [], 'legacy iw equals he');
  assert.deepEqual(run(asrLanguage, view({ agent: { asr: { language: 'zz' } }, avatars: [avatar('av1', voice('he'))] })), []);
  assert.deepEqual(run(asrLanguage, view({ agent: { asr: undefined }, avatars: [avatar('av1', voice('he'))] })), [], 'no asr field on the read');
});

test('asr_language_mismatch: a bilingual setup (en ASR, forced en, he voice) is left to the voice check', () => {
  const v = view({ intellect: { id: 10, type: 'brain', force_language: 'English' }, avatars: [avatar('av1', voice('he'))] });
  assert.deepEqual(run(asrLanguage, v), []);
});

test('asr_language_mismatch: an external intellect has no forced language, a missing voice is skipped', () => {
  const external = view({ intellect: { id: 10, type: 'external', force_language: 'Hebrew' }, avatars: [] });
  assert.deepEqual(run(asrLanguage, external), []);
  const unread = view({ avatars: [{ id: 'av1', state: 'found', voice: { id: 'v', state: 'unread' } }] });
  assert.deepEqual(run(asrLanguage, unread), []);
});

test('voice_reply_language_mismatch: an English voice with replies forced to Hebrew is an error', () => {
  const v = view({ agent: { asr: { language: 'he', provider: 'kaltura' } }, intellect: { id: 10, type: 'brain', force_language: 'Hebrew' }, avatars: [avatar('av1', voice('en'))] });
  const f = run(voiceReplyLanguage, v);
  assert.deepEqual(codes(f), ['error:voice_reply_language_mismatch']);
  assert.match(f[0].message, /"he".*"en"/s);
  assert.match(f[0].fix, /languageEqual: 'he'/);
});

test('voice_reply_language_mismatch: silent for a matching voice, no forced language, or an unrecognized voice language', () => {
  const forced = { id: 10, type: 'brain', force_language: 'Hebrew' };
  assert.deepEqual(run(voiceReplyLanguage, view({ intellect: forced, avatars: [avatar('av1', voice('he'))] })), []);
  assert.deepEqual(run(voiceReplyLanguage, view({ avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(voiceReplyLanguage, view({ intellect: forced, avatars: [avatar('av1', voice('zz'))] })), []);
});

test('voice_reply_language_mismatch: reports each avatar whose voice is wrong, not the right one', () => {
  const v = view({ intellect: { id: 10, type: 'brain', force_language: 'Hebrew' }, avatars: [avatar('av1', voice('he')), avatar('av2', voice('en'))] });
  const f = run(voiceReplyLanguage, v);
  assert.equal(f.length, 1);
  assert.match(f[0].field, /av2/);
});

test('voice_language_default: a custom voice that kept en on a Hebrew agent is info', () => {
  const v = view({ agent: { asr: { language: 'he' } }, avatars: [avatar('av1', voice('en', { adminTags: [] }))] });
  assert.deepEqual(codes(run(voiceLanguageDefault, v)), ['info:voice_language_default']);
});

test('voice_language_default: silent for a preset en voice, an en agent, or a custom voice in another language', () => {
  assert.deepEqual(run(voiceLanguageDefault, view({ agent: { asr: { language: 'he' } }, avatars: [avatar('av1', voice('en'))] })), [], 'preset');
  assert.deepEqual(run(voiceLanguageDefault, view({ avatars: [avatar('av1', voice('en', { adminTags: [] }))] })), [], 'en agent');
  assert.deepEqual(run(voiceLanguageDefault, view({ agent: { asr: { language: 'he' } }, avatars: [avatar('av1', voice('he', { adminTags: [] }))] })), []);
});

test('voice_not_in_catalog and visual_not_in_catalog: warn on a missing item, say a raw id can be valid', () => {
  const a = avatar('av1', { id: 'gone', state: 'missing' });
  a.visual = { id: 'vgone', state: 'missing' };
  const f = run(avatarReferences, view({ avatars: [a] }));
  assert.deepEqual(codes(f).sort(), ['warn:visual_not_in_catalog', 'warn:voice_not_in_catalog']);
  assert.match(f.find((x) => x.code === 'voice_not_in_catalog').message, /raw provider voice id can be valid/);
});

test('voice_not_in_catalog: silent for a found voice, an unread lookup and a scoped voice found by id', () => {
  assert.deepEqual(run(avatarReferences, view({ avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(avatarReferences, view({ avatars: [avatar('av1', { id: 'v', state: 'unread' })] })), []);
  const scoped = voice('he'); // found through catalog.get after the unscoped list missed it
  assert.deepEqual(run(avatarReferences, view({ avatars: [avatar('av1', scoped)] })), []);
});

test('avatar_not_found: an avatar the agent lists but the API does not have is an error', () => {
  const f = run(avatarReferences, view({ avatars: [{ id: 'av9', state: 'missing' }] }));
  assert.deepEqual(codes(f), ['error:avatar_not_found']);
  assert.deepEqual(run(avatarReferences, view({ avatars: [{ id: 'av9', state: 'unread' }] })), [], 'an unread avatar is not missing');
});

test('intellect_not_found: only for a missing intellect', () => {
  const missing = view({ intellect: null });
  assert.deepEqual(codes(run(intellectReference, missing)), ['error:intellect_not_found']);
  assert.deepEqual(run(intellectReference, view()), []);
  assert.deepEqual(run(intellectReference, { ...view(), intellectState: 'unread', intellect: undefined }), []);
  assert.deepEqual(run(intellectReference, { ...view(), intellectState: 'none', configId: undefined }), []);
});

test('opening_phrase_duplicate: both set is info; only one set, or none, is silent', () => {
  const brain = (phrase) => ({ id: 10, type: 'brain', ...(phrase ? { opening_phrase: phrase } : {}) });
  const both = view({ intellect: brain('Welcome'), avatars: [avatar('av1', voice('en'), { openingPhrase: 'Hi there' })] });
  assert.deepEqual(codes(run(openingPhraseDuplicate, both)), ['info:opening_phrase_duplicate']);
  assert.deepEqual(run(openingPhraseDuplicate, view({ intellect: brain(null), avatars: [avatar('av1', voice('en'), { openingPhrase: 'Hi there' })] })), [], 'the avatar phrase is the live one');
  assert.deepEqual(run(openingPhraseDuplicate, view({ intellect: brain('Welcome'), avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(openingPhraseDuplicate, view({ intellect: brain('Welcome'), avatars: [avatar('av1', voice('en'), { openingPhrase: '  ' })] })), []);
});

test('opening_phrase_language_mismatch: an English line with a Hebrew voice is info', () => {
  const v = view({ intellect: { id: 10, type: 'brain', opening_phrase: 'Hello and welcome, how can I help you today' }, avatars: [avatar('av1', voice('he'))] });
  assert.deepEqual(codes(run(openingPhraseLanguage, v)), ['info:opening_phrase_language_mismatch']);
});

test('opening_phrase_language_mismatch: silent for a matching script, Latin names in Hebrew text, es vs en, templates, SILENT_OPENING, short lines, external', () => {
  const hebrewVoice = [avatar('av1', voice('he'))];
  const brain = (opening_phrase) => ({ id: 10, type: 'brain', opening_phrase });
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: brain('שלום, אני העוזר של Kaltura ושל Acme'), avatars: hebrewVoice })), []);
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: brain('Hola, bienvenido a nuestra tienda'), avatars: [avatar('av1', voice('en'))] })), [], 'script is not language');
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: brain('{% if user_name %}שלום {{ user_name }}, ברוך הבא{% else %}שלום וברוך הבא{% endif %}'), avatars: hebrewVoice })), [], 'template code is not prose');
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: brain('<blank>'), avatars: hebrewVoice })), []);
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: brain('Hi!'), avatars: hebrewVoice })), []);
  assert.deepEqual(run(openingPhraseLanguage, view({ intellect: { id: 10, type: 'external' }, avatars: [avatar('av1', voice('he'), { openingPhrase: 'Hello and welcome here' })] })), []);
});

test('opening_phrase_language_mismatch: uses the avatar line when the intellect has none', () => {
  const v = view({ avatars: [avatar('av1', voice('he'), { openingPhrase: 'Hello and welcome, how can I help you today' })] });
  const f = run(openingPhraseLanguage, v);
  assert.equal(f.length, 1);
  assert.match(f[0].field, /av1 openingPhrase/);
});

test('max_conversation_short: under 60 s is info; 60 s, longer, or unset is silent; the limit is an option', () => {
  assert.deepEqual(codes(run(maxConversation, view({ agent: { maxConversationLength: 30 } }))), ['info:max_conversation_short']);
  assert.deepEqual(run(maxConversation, view({ agent: { maxConversationLength: 60 } })), []);
  assert.deepEqual(run(maxConversation, view({ agent: { maxConversationLength: 600 } })), []);
  assert.deepEqual(run(maxConversation, view()), []);
  assert.deepEqual(maxConversation.run(view({ agent: { maxConversationLength: 100 } }), { ...DEFAULT_THRESHOLDS, minConversationSeconds: 120 }).map((f) => f.code), ['max_conversation_short']);
});

test('capability_disabled_vetoes_avatar: stored disabled with avatars is an error', () => {
  const intellect = { id: 10, type: 'brain', capabilities: { avatar: 'disabled' } };
  assert.deepEqual(codes(run(avatarCapability, view({ intellect, avatars: [avatar('av1', voice('en'))] }))), ['error:capability_disabled_vetoes_avatar']);
  assert.deepEqual(run(avatarCapability, view({ intellect })), [], 'an agent with no avatars is headless');
  assert.deepEqual(run(avatarCapability, view({ intellect: { id: 10, type: 'brain', capabilities: { avatar: 'on' } }, avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(avatarCapability, view({ intellect: { id: 10, type: 'brain', capabilities: { avatar: 'off' } }, avatars: [avatar('av1', voice('en'))] })), [], 'off is overridable per request');
});

test('avatar_shared: lists every agent that uses an avatar, only when one of them is selected', () => {
  const mk = (agentId, avatarIds) => ({ agentId, agent: { agentId, avatarIds }, intellectState: 'none', avatars: [] });
  const agents = [mk('a1', ['av1', 'av2']), mk('a2', ['av1']), mk('a3', ['av3'])];
  const f = avatarShared.run({ agents, selected: new Set(['a1']) }, DEFAULT_THRESHOLDS);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].agentIds, ['a1', 'a2']);
  assert.equal(f[0].agentId, undefined);
  assert.deepEqual(avatarShared.run({ agents, selected: new Set(['a3']) }, DEFAULT_THRESHOLDS), [], 'a3 shares nothing');
  assert.deepEqual(avatarShared.run({ agents: [mk('a1', ['av1', 'av1'])], selected: new Set(['a1']) }, DEFAULT_THRESHOLDS), [], 'one agent listing it twice');
});

test('a clean agent (matching languages, found voice and visual, own intellect) gives zero findings from every check', () => {
  const v = view({
    agent: { asr: { language: 'he', provider: 'kaltura' }, maxConversationLength: 600 },
    intellect: { id: 10, type: 'brain', force_language: 'Hebrew', opening_phrase: 'שלום, איך אפשר לעזור לך היום', capabilities: { avatar: 'on' } },
    avatars: [avatar('av1', voice('he'))],
  });
  const findings = runChecks({ agents: [v], intellects: [], selected: new Set(['a1']) }, DEFAULT_THRESHOLDS);
  assert.deepEqual(findings, []);
});

test('the registry has unique ids, declared codes only, and a docs-ready code list', () => {
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length);
  assert.equal(new Set(DOCTOR_CODES).size, DOCTOR_CODES.length, 'no code is defined twice');
  for (const c of CHECKS) {
    assert.ok(c.codes.length > 0 && ['agent', 'intellect', 'partner'].includes(c.scope) && Array.isArray(c.needs), c.id);
  }
});

test('runChecks turns a throwing check into check_failed and runs the others', () => {
  const boom = { id: 'boom', category: 'test', scope: 'agent', needs: [], codes: ['x'], run() { throw new Error('bad input'); } };
  const findings = runChecks({ agents: [view()], intellects: [], selected: new Set(['a1']) }, DEFAULT_THRESHOLDS, [boom, maxConversation]);
  assert.deepEqual(codes(findings), ['info:check_failed']);
  assert.match(findings[0].message, /"boom".*bad input/);
  assert.equal(findings[0].agentId, 'a1');
  const ok = runChecks({ agents: [view({ agent: { maxConversationLength: 5 } })], intellects: [], selected: new Set(['a1']) }, DEFAULT_THRESHOLDS, [boom, maxConversation]);
  assert.deepEqual(codes(ok).sort(), ['info:check_failed', 'info:max_conversation_short']);
});

test('runChecks runs agent checks for the selection only, intellect checks per intellect, partner checks once', () => {
  const seen = [];
  const agentCheck = { id: 'a', category: 't', scope: 'agent', needs: [], codes: ['a'], run: (v) => { seen.push(`agent:${v.agentId}`); return []; } };
  const intellectCheck = { id: 'i', category: 't', scope: 'intellect', needs: [], codes: ['i'], run: (v) => { seen.push(`intellect:${v.configId}`); return []; } };
  const partnerCheck = { id: 'p', category: 't', scope: 'partner', needs: [], codes: ['p'], run: (v) => { seen.push(`partner:${v.agents.length}`); return []; } };
  const a1 = { ...view(), agentId: 'a1' };
  const a2 = { ...view(), agentId: 'a2' };
  runChecks({ agents: [a1, a2], intellects: [{ configId: 10, config: {}, agentIds: ['a1'], agents: [a1] }], selected: new Set(['a1']) }, DEFAULT_THRESHOLDS, [agentCheck, intellectCheck, partnerCheck]);
  assert.deepEqual(seen, ['agent:a1', 'intellect:10', 'partner:2']);
});

test('selectChecks: only keeps matches by id or category, skip drops them and wins', () => {
  const ids = (list) => list.map((c) => c.id).sort();
  assert.deepEqual(ids(selectChecks(CHECKS, { only: ['language'] })), ['asr-language', 'opening-phrase-language', 'voice-language-default', 'voice-reply-language']);
  assert.deepEqual(ids(selectChecks(CHECKS, { only: ['asr-language'] })), ['asr-language']);
  assert.ok(!ids(selectChecks(CHECKS, { skip: ['language'] })).includes('asr-language'));
  assert.deepEqual(ids(selectChecks(CHECKS, { only: ['language'], skip: ['asr-language'] })).includes('asr-language'), false);
  assert.equal(selectChecks(CHECKS, {}).length, CHECKS.length);
  assert.equal(selectChecks(CHECKS, { only: [] }).length, CHECKS.length, 'an empty only list means no filter');
});

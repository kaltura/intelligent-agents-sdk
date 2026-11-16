import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respellingStyle, respellingTableSharedProviders, silentOpeningVoice, spokenDigitsCrossLanguage, spokenFormRows, spokenOutputUndeclared } from '../../src/management/doctor/checks/speech.js';
import { providerOf, voicesOf } from '../../src/management/doctor/checks/agent.js';
import { CHECKS, DOCTOR_CODES, runChecks } from '../../src/management/doctor/checks/index.js';
import { DEFAULT_THRESHOLDS } from '../../src/management/doctor/model.js';

/** Pure checks over hand-built views. No network, no fakes. */

const voice = (language) => ({ id: `v-${language}`, state: 'found', item: { itemId: `v-${language}`, adminTags: [], attributes: { voice: { name: `Voice ${language}`, language } } } });
const avatar = (id, v) => ({ id, state: 'found', avatar: { id }, voice: v });
const agentView = (intellect, { avatars = [avatar('av1', voice('he'))], asr = 'en' } = {}) => ({
  agentId: 'a1', agent: { agentId: 'a1', asr: { language: asr, provider: 'kaltura' } }, configId: 10, intellectState: 'found', intellect, avatars,
});
const intellectView = (config, avatars = [avatar('av1', voice('en'))]) => ({ configId: 10, config, agentIds: ['a1'], agents: [{ agentId: 'a1', agent: {}, avatars }] });
const run = (check, v) => check.run(v, DEFAULT_THRESHOLDS);
const table = (rows) => ({ id: 10, type: 'brain', prompts: [{ key: 'pron', value: `Spoken forms:\n${rows.join('\n')}\n` }] });

test('spokenFormRows reads arrow rows with plain, curly and bulleted forms', () => {
  const rows = spokenFormRows(table(['EBITDA -> "ebitda"', '- KGER → “kay ger”', 'Non-GAAP => "non gap"', 'not a row']));
  assert.deepEqual(rows, [{ term: 'EBITDA', spoken: 'ebitda' }, { term: 'KGER', spoken: 'kay ger' }, { term: 'Non-GAAP', spoken: 'non gap' }]);
});

test('respelling_hyphen_or_mixed_case: flags KAY-ger and kayGer, not plain words, number hyphens or spaced capitals', () => {
  const f = run(respellingStyle, intellectView(table(['CAGR -> "KAY-ger"', 'X -> "kayGer"', 'EBITDA -> "ebitda"', 'Y -> "eighty-four million"', 'AI -> "A I"'])));
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'respelling_hyphen_or_mixed_case');
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /2 spoken form/);
  assert.match(f[0].message, /"KAY-ger"/);
  assert.deepEqual(f[0].agentIds, ['a1']);
});

test('respelling_hyphen_or_mixed_case: quiet with no table, and for an external intellect', () => {
  assert.deepEqual(run(respellingStyle, intellectView({ id: 10, type: 'brain', prompts: [{ value: 'Be nice.' }] })), []);
  assert.deepEqual(run(respellingStyle, intellectView({ id: 10, type: 'external', prompts: [{ value: 'X -> "KAY-ger"' }] })), []);
});

test('spoken_text_digits_cross_language: a he voice, English replies, digits in the opening and the table', () => {
  const cfg = { ...table(['Q3 -> "Q3"', 'EBITDA -> "ebitda"']), opening_phrase: 'Welcome. Revenue grew 12% this year.' };
  const f = run(spokenDigitsCrossLanguage, agentView(cfg));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].code, 'spoken_text_digits_cross_language');
  assert.equal(f[0].agentId, 'a1');
  assert.match(f[0].message, /"he"/);
  assert.match(f[0].message, /prompt row "Q3"/);
  assert.match(f[0].message, /opening_phrase/);
});

test('spoken_text_digits_cross_language: forced language wins over ASR language', () => {
  const cfg = { ...table(['A -> "12"']), force_language: 'Hebrew' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { asr: 'en' })), []);
});

test('spoken_text_digits_cross_language: quiet for a matching voice, a silent opening, words only, or an unknown language', () => {
  const cfg = { ...table(['A -> "12"']), opening_phrase: 'Revenue grew 12%.' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ ...table(['A -> "twelve"']), opening_phrase: '-' })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { asr: 'zz-unknown' })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [avatar('av1', voice('zz-unknown'))] })), []);
});

test('spoken_text_digits_cross_language: ignores digits inside template code', () => {
  const cfg = { id: 10, type: 'brain', opening_phrase: 'Welcome {% if x == 3 %}back{% endif %} to the review.' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg)), []);
});

const longPrompt = (extra = '') => ({ id: 10, type: 'brain', base_directive: `You are a helpful analyst who answers questions about the company results. Be brief and clear. ${'Stay on topic. '.repeat(15)}${extra}` });

test('spoken_output_undeclared: an avatar agent whose prompt never mentions speech', () => {
  const f = run(spokenOutputUndeclared, intellectView(longPrompt()));
  assert.deepEqual(f.map((x) => `${x.severity}:${x.code}`), ['info:spoken_output_undeclared']);
  assert.deepEqual(f[0].agentIds, ['a1']);
});

test('spoken_output_undeclared: quiet when the prompt says it, with no avatar, for a short prompt, or a non-English forced language', () => {
  assert.deepEqual(run(spokenOutputUndeclared, intellectView(longPrompt('Your reply is spoken aloud by a voice.'))), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView(longPrompt(), [])), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ id: 10, type: 'brain', base_directive: 'Be brief.' })), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ ...longPrompt(), force_language: 'French' })), []);
});

test('the speech checks are registered and their codes are doctor codes', () => {
  for (const c of [spokenOutputUndeclared, respellingStyle, spokenDigitsCrossLanguage]) {
    assert.ok(CHECKS.includes(c));
    assert.equal(c.category, 'speech');
    for (const code of c.codes) assert.ok(DOCTOR_CODES.includes(code));
  }
});

// ---- providerOf and the provider-aware pieces ----

const providerVoice = (language, ttsProvider, extra = {}) => ({ id: `v-${language}-${ttsProvider}`, state: 'found', item: { itemId: 'x', adminTags: [], attributes: { voice: { name: 'V', language, ...(ttsProvider === undefined ? {} : { ttsProvider }) } }, ...extra } });

test('providerOf: lower-cases and strips punctuation, so the live spellings match', () => {
  const p = (ttsProvider) => providerOf({ attributes: { voice: { ttsProvider } } });
  assert.equal(p('elevenLabs'), 'elevenlabs');
  assert.equal(p('ElevenLabs'), 'elevenlabs');
  assert.equal(p('eleven_labs'), 'elevenlabs');
  assert.equal(p(' cartesia '), 'cartesia');
  assert.equal(p(''), null);
  assert.equal(p('--'), null);
  assert.equal(p(7), null);
  assert.equal(p(undefined), null);
  assert.equal(providerOf(undefined), null);
  assert.equal(providerOf({}), null);
});

test('voicesOf carries the provider, and null when the item has none', () => {
  const v = agentView({ id: 10, type: 'brain' }, { avatars: [avatar('a', providerVoice('he', 'cartesia')), avatar('b', providerVoice('en')), { id: 'c', state: 'missing' }] });
  assert.deepEqual(voicesOf(v).map((x) => [x.avatarId, x.provider]), [['a', 'cartesia'], ['b', null]]);
});

const sharedRun = (config, ...avatarSets) => run(respellingTableSharedProviders, { configId: 10, config, agentIds: avatarSets.map((_, i) => `a${i + 1}`), agents: avatarSets.map((avatars, i) => ({ agentId: `a${i + 1}`, agent: {}, avatars })) });
const TABLE = table(['EBITDA -> "ebitda"']);

test('respelling_table_shared_across_providers: one table, two providers, one info finding with sorted names', () => {
  const f = sharedRun(TABLE, [avatar('a1', providerVoice('en', 'ElevenLabs'))], [avatar('a2', providerVoice('he', 'cartesia'))]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.equal(f[0].code, 'respelling_table_shared_across_providers');
  assert.equal(f[0].field, 'prompts');
  assert.equal(f[0].configId, 10);
  assert.deepEqual(f[0].agentIds, ['a1', 'a2']);
  assert.match(f[0].message, /cartesia, elevenlabs\./);
});

test('respelling_table_shared_across_providers: also fires for two avatars on one agent', () => {
  const f = sharedRun(TABLE, [avatar('a1', providerVoice('en', 'elevenLabs')), avatar('a2', providerVoice('en', 'cartesia'))]);
  assert.equal(f.length, 1);
});

test('respelling_table_shared_across_providers: quiet for one provider in any casing, one unknown provider, no table, external or unfound voices', () => {
  assert.deepEqual(sharedRun(TABLE, [avatar('a1', providerVoice('en', 'elevenLabs'))], [avatar('a2', providerVoice('en', 'ElevenLabs'))]), []);
  assert.deepEqual(sharedRun(TABLE, [avatar('a1', providerVoice('en', 'cartesia'))], [avatar('a2', providerVoice('en'))]), [], 'a voice with no provider is not a second provider');
  assert.deepEqual(sharedRun({ id: 10, type: 'brain', prompts: [{ value: 'Be brief.' }] }, [avatar('a1', providerVoice('en', 'cartesia'))], [avatar('a2', providerVoice('en', 'elevenLabs'))]), []);
  assert.deepEqual(sharedRun({ ...TABLE, type: 'external' }, [avatar('a1', providerVoice('en', 'cartesia'))], [avatar('a2', providerVoice('en', 'elevenLabs'))]), []);
  assert.deepEqual(sharedRun(TABLE, [avatar('a1', providerVoice('en', 'cartesia'))], [{ id: 'x', state: 'missing' }, { id: 'y', state: 'unread' }]), []);
  assert.deepEqual(sharedRun(TABLE), [], 'no agents');
});

// ---- spoken_text_digits_cross_language: edge cases ----

test('spoken_text_digits_cross_language: names the provider when the voice has one', () => {
  const f = run(spokenDigitsCrossLanguage, agentView({ ...table(['A -> "12"']) }, { avatars: [avatar('av1', providerVoice('he', 'cartesia'))] }));
  assert.match(f[0].message, /Voice "V" \(cartesia\) is made for "he"/);
  const g = run(spokenDigitsCrossLanguage, agentView({ ...table(['A -> "12"']) }, { avatars: [avatar('av1', providerVoice('he'))] }));
  assert.match(g[0].message, /Voice "V" is made for "he"/);
});

test('spoken_text_digits_cross_language: every digit and symbol the doctor knows triggers it', () => {
  for (const s of ['7', '1,200', '12%', '$5', 'R&D', '€4', '£3', 'item #9']) {
    const f = run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: `Welcome to ${s} today.` }));
    assert.equal(f.length, 1, `"${s}" should trigger`);
  }
  for (const s of ['twelve percent', 'R and D', 'the third quarter', 'Hello, there. Wait: really? Yes!']) {
    assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: s })), [], `"${s}" should not trigger`);
  }
});

test('spoken_text_digits_cross_language: lists every place, and the field is the first one', () => {
  const cfg = { ...table(['Q3 -> "Q3"', 'Y -> "2026"', 'Z -> "twenty"']), opening_phrase: 'Up 12%.' };
  const f = run(spokenDigitsCrossLanguage, agentView(cfg));
  assert.equal(f[0].field, 'prompt row "Q3"');
  assert.match(f[0].message, /prompt row "Q3", prompt row "Y", opening_phrase/);
  assert.doesNotMatch(f[0].message, /"Z"/);
});

test('spoken_text_digits_cross_language: a long list is cut to five places', () => {
  const rows = Array.from({ length: 8 }, (_, i) => `T${i} -> "${i}"`);
  const f = run(spokenDigitsCrossLanguage, agentView(table(rows)));
  assert.match(f[0].message, /and 3 more/);
});

test('spoken_text_digits_cross_language: with no intellect opening line, each avatar line is read', () => {
  const cfg = { id: 10, type: 'brain' };
  const a1 = { ...avatar('av1', voice('he')), avatar: { id: 'av1', openingPhrase: 'Up 12%.' } };
  const a2 = { ...avatar('av2', voice('he')), avatar: { id: 'av2', openingPhrase: 'Welcome.' } };
  const f = run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [a1, a2] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].field, 'avatar av1 openingPhrase');
});

test('spoken_text_digits_cross_language: the intellect line wins over an avatar line, and a silent intellect line speaks nothing', () => {
  const a1 = { ...avatar('av1', voice('he')), avatar: { id: 'av1', openingPhrase: 'Up 12%.' } };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: 'Welcome.' }, { avatars: [a1] })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: '-' }, { avatars: [a1] })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: '   ' }, { avatars: [{ ...a1, avatar: { id: 'av1', openingPhrase: '  ' } }] })), []);
});

test('spoken_text_digits_cross_language: skips an external intellect, a missing intellect, and no voice', () => {
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'external', opening_phrase: 'Up 12%.' })), []);
  const v = agentView({ id: 10, type: 'brain', opening_phrase: 'Up 12%.' });
  v.intellect = undefined; v.intellectState = 'missing';
  assert.deepEqual(run(spokenDigitsCrossLanguage, v), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: 'Up 12%.' }, { avatars: [] })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: 'Up 12%.' }, { avatars: [{ id: 'av1', state: 'missing' }] })), []);
});

test('spoken_text_digits_cross_language: region tags and legacy codes count as the same language', () => {
  const cfg = { id: 10, type: 'brain', opening_phrase: 'Up 12%.' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [avatar('av1', voice('en-GB'))] })), [], 'en-GB voice, en replies');
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ ...cfg, force_language: 'he' }, { avatars: [avatar('av1', voice('iw'))] })), [], 'iw is he');
  assert.equal(run(spokenDigitsCrossLanguage, agentView({ ...cfg, force_language: 'he' }, { avatars: [avatar('av1', voice('en-US'))] })).length, 1);
});

test('spoken_text_digits_cross_language: with several voices it names one that differs from the reply language', () => {
  const f = run(spokenDigitsCrossLanguage, agentView({ id: 10, type: 'brain', opening_phrase: 'Up 12%.' }, { avatars: [avatar('av1', voice('en')), avatar('av2', providerVoice('he', 'cartesia'))] }));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /\(cartesia\)/);
});

test('spoken_text_digits_cross_language: the fix names the agent for the ignore list', () => {
  const f = run(spokenDigitsCrossLanguage, agentView(table(['A -> "12"'])));
  assert.match(f[0].fix, /agentId: 'a1'/);
  assert.equal(f[0].configId, 10);
});

// ---- spokenFormRows ----

test('spokenFormRows: reads the base directive and every prompt block, and ignores non-string values', () => {
  const rows = spokenFormRows({ base_directive: 'A -> "a"', prompts: [{ value: 'B -> "b"' }, { value: 5 }, null, { key: 'x' }] });
  assert.deepEqual(rows.map((r) => r.term), ['A', 'B']);
  assert.deepEqual(spokenFormRows({}), []);
  assert.deepEqual(spokenFormRows({ prompts: 'nope' }), []);
});

test('spokenFormRows: handles CRLF text, indentation, star bullets and every arrow', () => {
  const rows = spokenFormRows({ prompts: [{ value: '  A -> "a"\r\n* B → "b"\r\n- C => "c"\r\n\tD -> "d" \r\n' }] });
  assert.deepEqual(rows.map((r) => `${r.term}=${r.spoken}`), ['A=a', 'B=b', 'C=c', 'D=d']);
});

test('spokenFormRows: skips rows that are not a whole `Term -> "form"` line', () => {
  const rows = spokenFormRows({ prompts: [{ value: [
    'Say it -> "ok" and then stop',
    'no arrow "ok"',
    'A -> ""',
    `T -> "${'x'.repeat(81)}"`,
    `${'t'.repeat(81)} -> "ok"`,
    'Good -> "good"',
  ].join('\n') }] });
  assert.deepEqual(rows, [{ term: 'Good', spoken: 'good' }]);
});

test('spokenFormRows: reads a table of bare rows (no quotes) when there are three or more', () => {
  const rows = spokenFormRows({ base_directive: 'Replace each term:\n\nEBITDA -> ee-BIT-dah\nNon-GAAP -> non-GAP\n1,200 -> twelve hundred\nP&L -> P and L\n' });
  assert.deepEqual(rows.map((r) => `${r.term}=${r.spoken}`), ['EBITDA=ee-BIT-dah', 'Non-GAAP=non-GAP', '1,200=twelve hundred', 'P&L=P and L']);
});

test('spokenFormRows: one or two bare arrows are prose, not a table', () => {
  assert.deepEqual(spokenFormRows({ prompts: [{ value: 'A -> b\nC -> d\n' }] }), []);
  assert.deepEqual(spokenFormRows({ prompts: [{ value: 'Flow: A -> B -> C\nX -> y.\nZ -> w:\nQ -> v\n' }] }), []);
});

test('spokenFormRows: bare rows mix with quoted rows and a row in both forms counts once', () => {
  const rows = spokenFormRows({
    base_directive: 'A -> a1\nB -> b1\nC -> c1\n',
    prompts: [{ value: 'A -> "a1"\nD -> "d1"\n' }],
  });
  assert.deepEqual(rows.map((r) => `${r.term}=${r.spoken}`).sort(), ['A=a1', 'B=b1', 'C=c1', 'D=d1']);
});

test('respelling_hyphen_or_mixed_case: finds hyphenated forms in a bare-row table', () => {
  const cfg = { id: 10, type: 'brain', base_directive: 'CAGR -> KAY-ger\nEBITDA -> ee-BIT-dah\nARR -> A R R\nNDR -> N D R\n' };
  const f = run(respellingStyle, intellectView(cfg));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /2 spoken form/);
});

test('spokenFormRows: two calls on the same config give the same rows (no shared regex state)', () => {
  const cfg = table(['A -> "a"', 'B -> "b"']);
  assert.deepEqual(spokenFormRows(cfg), spokenFormRows(cfg));
  assert.equal(spokenFormRows(cfg).length, 2);
});

// ---- respelling style: edge cases ----

test('respelling_hyphen_or_mixed_case: the judgment on each shape of spoken form', () => {
  const cases = {
    'KAY-ger': true, 'kay-ger': true, 'SHEV-uh-meh': true, 'kayGer': true, 'KAYger': true, 'eBIT-da': true,
    'kay ger': false, 'ebitda': false, 'A I': false, 'E E and T': false, 'R and D': false, 'FIFA': false,
    'twenty-five': false, 'eighty-four million': false, 'twelve-hundred': false, 'Twenty-One': false,
    'twenty-five-ish': true, 'Project seven twenty': false, 'e self A I': false,
  };
  for (const [spoken, flagged] of Object.entries(cases)) {
    const f = run(respellingStyle, intellectView(table([`T -> "${spoken}"`])));
    assert.equal(f.length === 1, flagged, `"${spoken}" flagged=${f.length === 1}, expected ${flagged}`);
  }
});

test('respelling_hyphen_or_mixed_case: a long list is cut to five and counts them all', () => {
  const rows = Array.from({ length: 7 }, (_, i) => `T${i} -> "AB-cd${i}"`);
  const f = run(respellingStyle, intellectView(table(rows)));
  assert.match(f[0].message, /^7 spoken form/);
  assert.match(f[0].message, /and 2 more/);
});

test('respelling_hyphen_or_mixed_case: the term side is never judged, only the spoken form', () => {
  assert.deepEqual(run(respellingStyle, intellectView(table(['Non-GAAP -> "non gap"', 'McDonald -> "mcdonald"']))), []);
});

// ---- spoken_output_undeclared: edge cases ----

const padTo = (n, lead = '') => ({ id: 10, type: 'brain', base_directive: `${(lead + ' ' + 'word '.repeat(300)).trimStart().slice(0, n - 1)}x` });

test('spoken_output_undeclared: fires at 200 prose characters and not below', () => {
  assert.equal(run(spokenOutputUndeclared, intellectView(padTo(200))).length, 1);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView(padTo(199))), []);
});

test('spoken_output_undeclared: every spoken word counts, in any prompt block, whole words only', () => {
  for (const w of ['spoken', 'speak', 'speech', 'aloud', 'text-to-speech', 'TTS', 'voice', 'pronounce', 'pronunciation']) {
    const cfg = { id: 10, type: 'brain', prompts: [{ value: padTo(300).base_directive }, { value: `Reminder: ${w}.` }] };
    assert.deepEqual(run(spokenOutputUndeclared, intellectView(cfg)), [], `"${w}" should count`);
  }
  assert.equal(run(spokenOutputUndeclared, intellectView(padTo(300, 'The unspoken rule of ttsless voiceover'))).length, 1, 'a word that only contains one does not count');
});

test('spoken_output_undeclared: a word inside template code does not count as prose', () => {
  const cfg = { id: 10, type: 'brain', base_directive: `${padTo(300).base_directive} {% if mode == "spoken" %}x{% endif %}` };
  assert.equal(run(spokenOutputUndeclared, intellectView(cfg)).length, 1);
});

test('spoken_output_undeclared: English or unknown forced language still fires, another known language does not', () => {
  assert.equal(run(spokenOutputUndeclared, intellectView({ ...padTo(300), force_language: 'en' })).length, 1);
  assert.equal(run(spokenOutputUndeclared, intellectView({ ...padTo(300), force_language: 'English' })).length, 1);
  assert.equal(run(spokenOutputUndeclared, intellectView({ ...padTo(300), force_language: 'zz-nope' })).length, 1);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ ...padTo(300), force_language: 'he' })), []);
});

test('spoken_output_undeclared: skips an external intellect and handles odd prompt shapes', () => {
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ ...padTo(300), type: 'external' })), []);
  assert.equal(run(spokenOutputUndeclared, intellectView({ id: 10, type: 'brain', prompts: [{ value: 'x '.repeat(150) }, null, { value: 3 }] })).length, 1);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ id: 10, type: 'brain' })), []);
});

// ---- silent_opening_*: the opening phrase against the voice provider ----

const silentRun = (opening, v = providerVoice('en', 'elevenLabs'), extra = {}) => run(silentOpeningVoice, agentView({ id: 10, type: 'brain', opening_phrase: opening }, { avatars: [avatar('av1', v)], ...extra }));

test('silent_opening_unsupported_voice: a silent opening on a Cartesia voice is an error naming the voice and provider', () => {
  for (const phrase of ['-', ' - ', '<blank>']) {
    const f = silentRun(phrase, providerVoice('en', 'cartesia'));
    assert.equal(f.length, 1, phrase);
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].code, 'silent_opening_unsupported_voice');
    assert.equal(f[0].field, 'opening_phrase');
    assert.equal(f[0].agentId, 'a1');
    assert.equal(f[0].configId, 10);
    assert.match(f[0].message, /cartesia/);
    assert.match(f[0].message, /never ended/);
  }
});

test('silent_opening_unsupported_voice: finds a silent branch in a template, not a dash inside a sentence', () => {
  const cartesia = providerVoice('en', 'cartesia');
  assert.equal(silentRun('{% if returning %}-{% else %}Welcome back.{% endif %}', cartesia)[0]?.code, 'silent_opening_unsupported_voice');
  assert.equal(silentRun('{% if returning %}Welcome back.{% else %} - {% endif %}', cartesia)[0]?.code, 'silent_opening_unsupported_voice');
  assert.deepEqual(silentRun('Hello{% if vip %} - {% endif %}there.', cartesia), []);
  assert.deepEqual(silentRun('Hello - welcome.', cartesia), []);
});

test('silent_opening_unsupported_voice: uses the avatar line when the intellect has none, and says which', () => {
  const v = agentView({ id: 10, type: 'brain' }, { avatars: [{ id: 'av1', state: 'found', avatar: { id: 'av1', openingPhrase: '-' }, voice: providerVoice('en', 'cartesia') }] });
  const f = run(silentOpeningVoice, v);
  assert.equal(f.length, 1);
  assert.equal(f[0].field, 'avatar av1 openingPhrase');
  const spoken = agentView({ id: 10, type: 'brain', opening_phrase: 'Hi.' }, { avatars: [{ id: 'av1', state: 'found', avatar: { id: 'av1', openingPhrase: '-' }, voice: providerVoice('en', 'cartesia') }] });
  assert.deepEqual(run(silentOpeningVoice, spoken), [], 'the intellect line wins over the avatar line');
});

test('silent_opening_legacy_phrase: <blank> on any other voice is a warning with the replacement call', () => {
  for (const v of [providerVoice('en', 'elevenLabs'), providerVoice('en'), voice('en')]) {
    const f = silentRun('<blank>', v);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'warn');
    assert.equal(f[0].code, 'silent_opening_legacy_phrase');
    assert.match(f[0].fix, /setOpeningPhrase\(configId, SILENT_OPENING/);
  }
  assert.equal(silentRun('{% if a %}<blank>{% else %}Hi there.{% endif %}')[0]?.code, 'silent_opening_legacy_phrase');
  assert.equal(silentRun('<blank>', providerVoice('en', 'cartesia')).length, 1, 'one finding, the voice one');
});

test('silent opening checks: quiet for the dash on ElevenLabs or an unknown provider, spoken lines, text around <blank>, no opening, external intellect, unfound voices', () => {
  assert.deepEqual(silentRun('-'), []);
  assert.deepEqual(silentRun('-', providerVoice('en')), []);
  assert.deepEqual(silentRun('Welcome.', providerVoice('en', 'cartesia')), []);
  assert.deepEqual(silentRun('<blank> hi'), []);
  assert.deepEqual(run(silentOpeningVoice, agentView({ id: 10, type: 'brain' })), []);
  assert.deepEqual(run(silentOpeningVoice, agentView({ id: 10, type: 'external', opening_phrase: '-' })), []);
  assert.deepEqual(silentRun('-', undefined, { avatars: [{ id: 'x', state: 'missing' }] }), [], 'no voice found, nothing to say about a provider');
});

// ---- registry ----

test('every speech check has unique codes, the speech category, and is listed once', () => {
  const speech = CHECKS.filter((c) => c.category === 'speech');
  assert.deepEqual(speech.map((c) => c.id).sort(), ['respelling-style', 'respelling-table-shared-providers', 'silent-opening-voice', 'spoken-digits-cross-language', 'spoken-output-undeclared']);
  const all = speech.flatMap((c) => c.codes);
  assert.equal(new Set(all).size, all.length);
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length);
});

test('a speech check that gets a malformed view does not throw out of runChecks', () => {
  const model = { agents: [{ agentId: 'a1', agent: null, avatars: [], intellectState: 'found', intellect: { id: 1, type: 'brain', prompts: [{ value: 'A -> "x"' }] } }], intellects: [{ configId: 1, config: { id: 1, type: 'brain' }, agentIds: [], agents: [] }], selected: new Set(['a1']) };
  const findings = runChecks(model, DEFAULT_THRESHOLDS, CHECKS.filter((c) => c.category === 'speech'));
  assert.ok(findings.every((f) => f.code === 'check_failed' || typeof f.code === 'string'));
});

test('spoken_text_digits_cross_language: a view with no configId and an avatar with no record still works', () => {
  const v = agentView({ id: 10, type: 'brain', opening_phrase: 'Up 12%.' });
  delete v.configId;
  const f = run(spokenDigitsCrossLanguage, v);
  assert.equal(f.length, 1);
  assert.equal('configId' in f[0], false);
  const bare = agentView({ id: 10, type: 'brain' }, { avatars: [{ id: 'av1', state: 'found', voice: voice('he') }] });
  assert.deepEqual(run(spokenDigitsCrossLanguage, bare), []);
});

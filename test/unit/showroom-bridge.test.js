// Showroom example: the bridge between session, store and body, run with the scripted demo session.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoSession } from '../../examples/showroom/js/demo-session.js';
import { createBridge, buildVars } from '../../examples/showroom/js/bridge.js';
import { createStore } from '../../examples/showroom/js/store.js';
import { reducer, initialState } from '../../examples/showroom/js/reducer.js';
import { TOOL_NAMES } from '../../examples/showroom/js/tools.js';
import * as spec from '../../examples/showroom/agent/spec.mjs';
import { lintPrompts, lintPersonaIdentity } from '../../src/management/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(bridgeOpts = {}) {
  const session = new DemoSession({ speed: 0 });
  const store = createStore(reducer, initialState());
  const log = { perform: [], speaking: [], live: [], captions: [], announced: [], status: [] };
  const body = {
    perform: (n, d) => log.perform.push(d ? `${n}:${d}` : n),
    setSpeaking: (b) => log.speaking.push(b), setThinking() {}, setListening() {}, setLive: (b) => log.live.push(b),
  };
  const captions = { show: (who, text) => log.captions.push([who, text]), clear() {}, announce: (t) => log.announced.push(t) };
  const bridge = createBridge({ session, store, body, captions, onStatus: (s) => log.status.push(s), noteDelayMs: 5, ...bridgeOpts });
  return { session, store, bridge, log };
}

describe('bridge', () => {
  test('a spoken request runs the tool, changes the screen and syncs request vars', async () => {
    const { session, store, bridge, log } = setup();
    await session.connect();
    bridge.start();
    session.hear('show me the flip');
    await wait(30);
    assert.equal(store.getState().scene, 'device');
    assert.equal(store.getState().deviceId, 'orbit-flip');
    assert.match(session.requestVars.screen, /Orbit Flip page/);
    assert.ok(log.perform.includes('present:right'));
    assert.ok(log.captions.some(([who]) => who === 'user'));
    assert.ok(log.captions.some(([who]) => who === 'agent'), 'agent caption from the CaptionService');
    assert.ok(log.announced.length > 0, 'finished sentence for screen readers');
    bridge.destroy();
    session.disconnect();
  });

  test('start() shows "ready", then the agent greeting takes over without a second intro', async () => {
    const { session, bridge, log } = setup({ introWaitMs: 40 });
    await session.connect();
    bridge.start();
    assert.equal(log.status[0], 'ready');
    await wait(80);
    assert.ok(log.status.includes('speaking'), 'the greeting spoke');
    assert.deepEqual(session.turns, [], 'no fallback intro was sent');
    bridge.destroy();
    session.disconnect();
  });

  test('a silent agent is asked to introduce itself, and "ready" gives way to listening', async () => {
    const { session, bridge, log } = setup({ introWaitMs: 20 });
    session.connect = async () => { session.connected = true; }; // a backend that does not greet
    await session.connect();
    bridge.start();
    assert.equal(log.status.at(-1), 'ready');
    await wait(50);
    assert.equal(session.turns.length, 1);
    assert.match(session.turns[0], /just arrived.*Introduce yourself/);
    assert.ok(['listening', 'thinking', 'speaking'].includes(log.status.at(-1)), `status was ${log.status.at(-1)}`);
    bridge.destroy();
    session.disconnect();
  });

  test('a tap before the greeting counts as the first turn: no intro is added', async () => {
    const { session, bridge, log } = setup({ introWaitMs: 30 });
    session.connect = async () => { session.connected = true; };
    await session.connect();
    bridge.start();
    bridge.ask('What phones do you have?');
    await wait(60);
    assert.deepEqual(session.turns, ['What phones do you have?']);
    assert.equal(log.status[0], 'ready');
    bridge.destroy();
    session.disconnect();
  });

  test('follow-up chips: the agent offers them, a tap asks the question, the next turn clears them', async () => {
    const { session, store, bridge, log } = setup();
    await session.connect();
    bridge.start();
    session.hear('show me the flip');
    await wait(30);
    assert.deepEqual(store.getState().suggestions, ['Add it to my cart', 'Show me a case for it']);
    bridge.ask('Show me a case for it');
    assert.deepEqual(store.getState().suggestions, [], 'a tap clears the chips');
    assert.deepEqual(log.captions.at(-1), ['user', 'Show me a case for it']);
    assert.deepEqual(session.turns, ['Show me a case for it']);
    await wait(30);
    session.hear('what plans');
    await wait(30);
    assert.deepEqual(store.getState().suggestions, ['Pick the Plus plan', 'Can I trade in my phone?']);
    session.hear('tell me a joke');
    await wait(30);
    assert.deepEqual(store.getState().suggestions, [], 'a new turn without chips clears the old ones');
    bridge.destroy();
    session.disconnect();
  });

  test('touching the screen clears stale chips', async () => {
    const { session, store, bridge } = setup();
    await session.connect();
    bridge.start();
    session.hear('show me the flip');
    await wait(30);
    assert.equal(store.getState().suggestions.length, 2);
    bridge.tap({ type: 'show', scene: 'plans' });
    assert.deepEqual(store.getState().suggestions, []);
    bridge.destroy();
    session.disconnect();
  });

  test('taps change state the same way and send one batched note', async () => {
    const { session, store, bridge } = setup();
    await session.connect();
    bridge.start();
    bridge.tap({ type: 'show', scene: 'device', deviceId: 'orbit-lite' });
    bridge.tap({ type: 'choose-option', kind: 'color', value: 'sky' });
    bridge.tap({ type: 'choose-option', kind: 'storage', value: 128 });
    await wait(40);
    assert.equal(session.turns.length, 1);
    assert.match(session.turns[0], /tapped Orbit Lite.*picked the color Skyline.*picked 128 GB/);
    assert.equal(store.getState().colorId, 'sky');
    bridge.destroy();
    session.disconnect();
  });

  test('request vars follow every change and carry the cart', async () => {
    const { session, bridge } = setup();
    await session.connect();
    bridge.start();
    bridge.tap({ type: 'add-accessory', id: 'buds' });
    await wait(10);
    assert.match(session.requestVars.cart, /Orbit Buds x1/);
    assert.deepEqual(Object.keys(buildVars(initialState())), ['screen', 'cart']);
    bridge.destroy();
    session.disconnect();
  });

  test('no note or vars are sent before start()', async () => {
    const { session, bridge } = setup();
    bridge.tap({ type: 'show', scene: 'plans' });
    await wait(30);
    assert.equal(session.turns.length, 0);
    assert.deepEqual(session.requestVars, {});
    bridge.destroy();
  });

  test('a placed order celebrates; first video frame marks the body live', async () => {
    const { session, store, bridge, log } = setup();
    await session.connect();
    bridge.start();
    session.emit('mediaReady', { mode: 'video' });
    session.hear('add earbuds');
    await wait(20);
    session.hear('place my order');
    await wait(20);
    assert.equal(store.getState().scene, 'done');
    assert.ok(log.perform.includes('celebrate'));
    assert.deepEqual(log.live, [true]);
    bridge.destroy();
    session.disconnect();
  });

  test('destroy detaches every listener', async () => {
    const { session, store, bridge } = setup();
    await session.connect();
    bridge.start();
    bridge.destroy();
    session.hear('show phones');
    await wait(20);
    assert.equal(store.getState().scene, 'welcome');
    session.disconnect();
  });
});

describe('agent spec', () => {
  test('prompts pass both linters', () => {
    const prompts = lintPrompts(spec.PROMPTS, { allowClientVariables: true, knownVars: ['screen', 'cart'] });
    const identity = lintPersonaIdentity({ name: spec.PERSONA_NAME, openingPhrase: spec.OPENING_PHRASE, baseDirective: spec.BASE_DIRECTIVE, prompts: spec.PROMPTS });
    assert.deepEqual(prompts.findings ?? prompts, []);
    assert.deepEqual(identity.findings ?? identity, []);
  });
  test('one platform tool per app tool, same names', () => {
    const configs = spec.toolConfigs();
    assert.deepEqual(configs.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const t of configs) assert.equal(t.wait_for_response, false, t.name);
  });
  test('the prompts hold the screen and cart variables', () => {
    const all = spec.PROMPTS.map((p) => p.content ?? p.value ?? '').join('\n');
    assert.match(all, /\{\{screen\}\}/);
    assert.match(all, /\{\{cart\}\}/);
  });
  test('the opening phrase greets on a new thread only', () => {
    assert.match(spec.OPENING_PHRASE, /sys__is_new_thread/);
    assert.ok(spec.OPENING_PHRASE.includes(spec.PERSONA_NAME));
  });
});

describe('showroom sources', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/showroom');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
    }
  })(root);

  test('no innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/, path.relative(root, f));
  });
  test('no TODO, FIXME or HACK', () => {
    for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\b(TODO|FIXME|HACK)\b/, path.relative(root, f));
  });

  test('slow-agent signals reach the customer as captions', async () => {
    const { session, bridge, log } = setup();
    await session.connect();
    bridge.start();
    session.emit('brainStalled', { afterMs: 8000, count: 1 });
    session.emit('toolSpiralDetected', { count: 10, limit: 10 });
    session.emit('toolSpiralRecovering', { count: 30, limit: 30, lastTurnText: 'x' });
    const lines = log.captions.map((c) => c[1]).join(' | ');
    assert.match(lines, /still working/);
    assert.match(lines, /different way/);
    assert.match(lines, /Reconnecting/);
    assert.equal(log.status.at(-1), 'connecting');
  });
});

describe('bridge mute', () => {
  test('the mute state is the bridge\'s own: a session with no muted flag still unmutes', async () => {
    const { session, bridge, log } = setup();
    // The live session exposes mute() and unmute() but no flag to read back.
    session.mute = () => {};
    session.unmute = () => {};
    delete session.muted;
    await session.connect();
    bridge.start();
    bridge.setMuted(true);
    assert.equal(bridge.muted, true);
    assert.equal(log.status.at(-1), 'muted');
    bridge.setMuted(false);
    assert.equal(bridge.muted, false);
    assert.equal(log.status.at(-1), 'listening');
    bridge.destroy();
    session.disconnect();
  });
});

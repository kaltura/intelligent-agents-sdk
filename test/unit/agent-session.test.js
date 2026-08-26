// KalturaAgentSession — the mode-switching facade. Fake transports (injected
// via cfg.transportFactories) prove the facade's own contract offline: the
// single state machine, event forwarding, thread continuity across a switch,
// canonical request_vars ownership, tool-handler re-registration, send
// buffering during a switch, and ended/failure semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAgentSession, Emitter } from '../../src/experience/index.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** A transport-shaped fake capturing everything the facade does to it. */
class FakeTransport extends Emitter {
  constructor(cfg, kind) {
    super();
    this.cfg = cfg;
    this.kind = kind;
    this.state = 'idle';
    this.threadId = cfg.threadId;
    this.calls = [];
    this.toolHandlers = [];
    this.connectImpl = null;   // override per test
  }
  async connect() {
    this.calls.push(['connect']);
    if (this.connectImpl) await this.connectImpl();
    this.state = 'connected';
  }
  disconnect() { this.calls.push(['disconnect']); this.state = 'closed'; }
  async speak(text) { this.calls.push(['speak', text]); }
  async sendText(text, opts) { this.calls.push(['sendText', text, opts]); return { text: `echo:${text}`, threadId: this.threadId }; }
  onToolCall(name, handler, schema) {
    const entry = { name, handler, schema };
    this.toolHandlers.push(entry);
    return () => { const i = this.toolHandlers.indexOf(entry); if (i >= 0) this.toolHandlers.splice(i, 1); };
  }
  async respondToTool(id, response) { this.calls.push(['respondToTool', id, response]); return { ok: true }; }
  setDynamicPrompt(data) { this.calls.push(['setDynamicPrompt', data]); }
  updateRequestVars(vars) { this.calls.push(['updateRequestVars', vars]); }
}

/**
 * @param {object} [opts]
 * @returns {{session: KalturaAgentSession, made: {avatar: FakeTransport[], chat: FakeTransport[]}}}
 */
function newSession(opts = {}) {
  const made = { avatar: [], chat: [] };
  const session = new KalturaAgentSession({
    token: CONV_KS,
    transportFactories: {
      avatar: (cfg) => { const t = new FakeTransport(cfg, 'avatar'); made.avatar.push(t); if (opts.prep) opts.prep(t); return t; },
      chat: (cfg) => { const t = new FakeTransport(cfg, 'chat'); made.chat.push(t); if (opts.prep) opts.prep(t); return t; },
    },
    ...(opts.cfg || {}),
  });
  return { session, made };
}

// ───────────────────────── construction / connect ─────────────────────────

test('requires token and a valid mode; validates requestVars at construction', () => {
  assert.throws(() => new KalturaAgentSession({}), (e) => e.code === 'bad_request');
  assert.throws(() => new KalturaAgentSession({ token: CONV_KS, mode: 'video' }), (e) => e.code === 'bad_request');
  assert.throws(() => new KalturaAgentSession({ token: CONV_KS, requestVars: { sys__user_id: 'x' } }), (e) => e.code === 'validation_error');
});

test('connect builds the starting transport with the merged shared cfg and forwards its events', async () => {
  const { session, made } = newSession({
    cfg: { mode: 'chat', requestVars: { user_name: 'Dana' }, threadId: 'seed-1', chat: { genieUrl: 'https://genie.example.com' } },
  });
  const changed = [];
  session.on('transportChanged', (p) => changed.push(p));
  await session.connect();
  assert.equal(session.state, 'connected');
  assert.equal(session.mode, 'chat');
  const t = made.chat[0];
  assert.equal(t.cfg.token, CONV_KS);
  assert.deepEqual(t.cfg.requestVars, { user_name: 'Dana' });
  assert.equal(t.cfg.threadId, 'seed-1');
  assert.equal(t.cfg.genieUrl, 'https://genie.example.com');
  assert.deepEqual(changed, [{ mode: 'chat', transport: t }]);
  assert.equal(session.transport, t);
  // Forwarding: a transport event surfaces on the facade with the same payload.
  const got = [];
  session.on('transcript', (p) => got.push(p));
  t.emit('transcript', { text: 'hi', type: 'final' });
  assert.deepEqual(got, [{ text: 'hi', type: 'final' }]);
});

test('connect is once-only; failure lands in failed with the right reason', async () => {
  const boom = Object.assign(new Error('mic denied'), { code: 'permission_denied' });
  const { session, made } = newSession({ prep: (t) => { t.connectImpl = () => { throw boom; }; } });
  const states = [];
  session.on('stateChange', (p) => states.push(p));
  await assert.rejects(() => session.connect(), boom);
  assert.equal(session.state, 'failed');
  assert.deepEqual(states, [{ state: 'connecting' }, { state: 'failed', reason: 'permission_denied' }]);
  assert.equal(made.avatar[0].calls.filter((c) => c[0] === 'disconnect').length, 1, 'failed transport is torn down');
  await assert.rejects(() => session.connect(), (e) => e.code === 'invalid_state');
});

test('a non-permission connect failure reports transport_failed', async () => {
  const { session } = newSession({ prep: (t) => { t.connectImpl = () => { throw new Error('socket down'); }; } });
  const states = [];
  session.on('stateChange', (p) => states.push(p));
  await assert.rejects(() => session.connect(), /socket down/);
  assert.deepEqual(states.at(-1), { state: 'failed', reason: 'transport_failed' });
});

// ───────────────────────── sendText delegation ─────────────────────────

test('sendText delegates: chat → transport.sendText, avatar → transport.speak', async () => {
  const chat = newSession({ cfg: { mode: 'chat' } });
  await chat.session.connect();
  const r = await chat.session.sendText('hello');
  assert.equal(r.text, 'echo:hello');
  assert.equal(chat.made.chat[0].calls.at(-1)[0], 'sendText');

  const av = newSession();   // default mode: avatar
  await av.session.connect();
  const r2 = await av.session.sendText('hello');
  assert.equal(r2, undefined);
  assert.deepEqual(av.made.avatar[0].calls.at(-1), ['speak', 'hello']);
  await assert.rejects(() => new KalturaAgentSession({ token: CONV_KS }).sendText('x'), (e) => e.code === 'invalid_state');
});

// ───────────────────────── switchMode ─────────────────────────

test('switchMode: same-target is a no-op; full avatar→chat switch carries thread + canonical vars', async () => {
  const { session, made } = newSession({ cfg: { requestVars: { user_name: 'Dana' } } });
  await session.connect();
  const events = [];
  session.on('stateChange', (p) => events.push(['state', p]));
  session.on('modeChanged', (p) => events.push(['modeChanged', p]));
  session.on('transportChanged', (p) => events.push(['transportChanged', p.mode]));

  await session.switchMode('avatar');   // same target — nothing happens
  assert.equal(events.length, 0);
  assert.equal(made.avatar.length, 1);

  // Simulate a conversation having happened + a mid-conversation vars update.
  made.avatar[0].threadId = 't-live-7';
  session.updateRequestVars({ plan: 'pro' });

  await session.switchMode('chat');
  assert.equal(session.mode, 'chat');
  assert.equal(session.state, 'connected');
  const chat = made.chat[0];
  assert.equal(chat.cfg.threadId, 't-live-7', 'new transport is seeded with the captured thread');
  assert.deepEqual(chat.cfg.requestVars, { user_name: 'Dana', plan: 'pro' }, 'canonical vars incl. mid-conversation updates');
  assert.equal(made.avatar[0].calls.filter((c) => c[0] === 'disconnect').length, 1, 'old transport torn down');
  assert.deepEqual(events, [
    ['state', { state: 'switching', reason: 'user_requested' }],
    ['transportChanged', 'chat'],
    ['state', { state: 'connected' }],
    ['modeChanged', { mode: 'chat', threadContinuity: true }],
  ]);
  assert.equal(session.threadId, 't-live-7');
});

test('switchMode before any turn reports threadContinuity:false', async () => {
  const { session } = newSession();
  await session.connect();
  const modes = [];
  session.on('modeChanged', (p) => modes.push(p));
  await session.switchMode('chat');
  assert.deepEqual(modes, [{ mode: 'chat', threadContinuity: false }]);
});

test('switchMode guards: not connected, or another switch in flight', async () => {
  const { session } = newSession();
  await assert.rejects(() => session.switchMode('chat'), (e) => e.code === 'invalid_state');
  await session.connect();
  await assert.rejects(() => session.switchMode('voice'), (e) => e.code === 'bad_request');
  let release;
  const gate = new Promise((r) => { release = r; });
  session._cfg.transportFactories.chat = (cfg) => { const t = new FakeTransport(cfg, 'chat'); t.connectImpl = () => gate; return t; };
  const first = session.switchMode('chat');
  await assert.rejects(() => session.switchMode('avatar'), (e) => e.code === 'invalid_state');
  release();
  await first;
  assert.equal(session.mode, 'chat');
});

test('switch failure: facade lands in failed, buffered sends reject with the switch error', async () => {
  const { session, made } = newSession();
  await session.connect();
  let reject;
  const gate = new Promise((_, r) => { reject = r; });
  session._cfg.transportFactories.chat = (cfg) => { const t = new FakeTransport(cfg, 'chat'); t.connectImpl = () => gate; made.chat.push(t); return t; };
  const sw = session.switchMode('chat');
  const buffered = session.sendText('while switching');
  reject(new Error('genie unreachable'));
  await assert.rejects(() => sw, /genie unreachable/);
  await assert.rejects(() => buffered, /genie unreachable/);
  assert.equal(session.state, 'failed');
  assert.equal(made.chat[0].calls.filter((c) => c[0] === 'disconnect').length, 1, 'half-built transport torn down');
});

test('sends buffered during a switch flush to the new transport; overflow past the cap throws', async () => {
  const { session, made } = newSession();
  await session.connect();
  let release;
  const gate = new Promise((r) => { release = r; });
  session._cfg.transportFactories.chat = (cfg) => { const t = new FakeTransport(cfg, 'chat'); t.connectImpl = () => gate; made.chat.push(t); return t; };
  const sw = session.switchMode('chat');
  const pending = [];
  for (let i = 0; i < 8; i++) pending.push(session.sendText(`msg-${i}`));
  await assert.rejects(() => session.sendText('msg-8'), (e) => e.code === 'invalid_state');
  release();
  await sw;
  const results = await Promise.all(pending);
  assert.equal(results[0].text, 'echo:msg-0');
  assert.equal(results[7].text, 'echo:msg-7');
  const sent = made.chat[0].calls.filter((c) => c[0] === 'sendText').map((c) => c[1]);
  assert.deepEqual(sent, ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6', 'msg-7'], 'buffered sends arrive in order on the NEW transport');
});

// ───────────────────────── tool registry ─────────────────────────

test('onToolCall handlers re-register on the new transport after a switch; unsubscribe works', async () => {
  const { session, made } = newSession();
  const handler = () => {};
  const schema = { n: { type: 'int' } };
  const off = session.onToolCall('go', handler, schema);   // registered before connect — attaches on connect
  await session.connect();
  assert.equal(made.avatar[0].toolHandlers.length, 1);
  assert.equal(made.avatar[0].toolHandlers[0].schema, schema);
  await session.switchMode('chat');
  assert.equal(made.chat[0].toolHandlers.length, 1, 'handler survives the switch');
  assert.equal(made.chat[0].toolHandlers[0].handler, handler);
  off();
  assert.equal(made.chat[0].toolHandlers.length, 0, 'unsubscribe removes from the live transport');
  await session.switchMode('avatar');
  assert.equal(made.avatar[1].toolHandlers.length, 0, 'and from the registry');
  assert.throws(() => session.onToolCall('', handler), (e) => e.code === 'bad_request');
  assert.throws(() => session.onToolCall('x', null), (e) => e.code === 'bad_request');
});

// ───────────────────────── delegation + canonical vars ─────────────────────────

test('respondToTool / setDynamicPrompt / updateRequestVars delegate; vars merge into the canonical map first', async () => {
  const { session, made } = newSession();
  await session.connect();
  assert.deepEqual(await session.respondToTool('inv-1', { ok: 1 }), { ok: true });
  session.setDynamicPrompt({ page: '/pricing' });
  session.updateRequestVars({ plan: 'pro' });
  assert.throws(() => session.updateRequestVars({ secrets: 'nope' }), (e) => e.code === 'validation_error');
  const t = made.avatar[0];
  assert.deepEqual(t.calls.filter((c) => c[0] !== 'connect'), [
    ['respondToTool', 'inv-1', { ok: 1 }],
    ['setDynamicPrompt', { page: '/pricing' }],
    ['updateRequestVars', { plan: 'pro' }],
  ]);
  await session.switchMode('chat');
  const vars = made.chat[0].cfg.requestVars;
  assert.equal(vars.plan, 'pro');
  assert.deepEqual(JSON.parse(vars.page_context), { page: '/pricing' });
});

// ───────────────────────── ended / disconnect ─────────────────────────

test('transport-initiated ended → facade failed + forwarded; own disconnect → single ended, closed', async () => {
  const a = newSession();
  await a.session.connect();
  const endedA = [], statesA = [];
  a.session.on('ended', (p) => endedA.push(p));
  a.session.on('stateChange', (p) => statesA.push(p));
  a.made.avatar[0].emit('ended', { reason: 'server_disconnect' });
  assert.equal(a.session.state, 'failed');
  assert.deepEqual(endedA, [{ reason: 'server_disconnect' }]);
  assert.deepEqual(statesA, [{ state: 'failed', reason: 'transport_failed' }]);

  const b = newSession();
  await b.session.connect();
  const endedB = [];
  b.session.on('ended', (p) => endedB.push(p));
  b.session.disconnect();
  b.session.disconnect();   // idempotent
  assert.equal(b.session.state, 'closed');
  assert.deepEqual(endedB, [{ reason: 'disconnected' }], 'own teardown emits exactly one ended — the transport bridge is detached first');
  assert.equal(b.made.avatar[0].calls.filter((c) => c[0] === 'disconnect').length, 1);
  await assert.rejects(() => b.session.sendText('x'), (e) => e.code === 'invalid_state');
});

test('token is non-enumerable — never serializes off the facade', () => {
  const { session } = newSession();
  assert.ok(!JSON.stringify(session).includes(CONV_KS));
  assert.ok(!Object.keys(session).includes('_token'));
});

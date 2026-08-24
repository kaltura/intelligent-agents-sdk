import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

/**
 * Compliance controls on the Experience front: OWASP LLM01 (onBeforeSend guardrail),
 * LLM05 (inbound clamping), LLM06/Agentic (onAgentAction gate + agentActions policy +
 * capability surface), LLM10 (turn-rate valve), HIPAA 164.312(a)(2)(iii) (idle
 * auto-logoff) + 164.312(a)(2)(i) (subjectId on audit) + 164.312(b) (turn audit),
 * and avatar/deepfake disclosure provenance (EU AI Act Art. 50).
 */
const KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function mk(over = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const s = new KalturaAvatarSession({
    token: KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.x',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket,
    rtcConstructor: FakeRTCPeerConnection, networkAware: false,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\na', headers: { get: () => 'https://srs/whep/1' } }),
    getUserMedia: fakeGetUserMedia(), ...over,
  });
  return { s, socket };
}
const connected = async (over) => { const { s, socket } = mk(over); scriptHappyPath(socket); await s.connect(); return { s, socket }; };

// ── LLM01: onBeforeSend guardrail ──
test('onBeforeSend can transform outbound text', async () => {
  const { s, socket } = await connected({ onBeforeSend: (t) => t.replace(/secret/gi, '[redacted]') });
  await s.speak('my secret code');
  assert.equal(socket.emitsOf('onTextEntered').pop().text, 'my [redacted] code');
  s.disconnect();
});

test('onBeforeSend can BLOCK a turn (throw) → guardrail_blocked, nothing sent', async () => {
  const { s, socket } = await connected({ onBeforeSend: () => { throw new Error('policy'); } });
  await assert.rejects(() => s.speak('blocked'), (e) => e.code === 'guardrail_blocked');
  assert.equal(socket.didEmit('onTextEntered'), false);
  s.disconnect();
});

test('onBeforeSend returning false blocks the turn', async () => {
  const { s, socket } = await connected({ onBeforeSend: () => false });
  await assert.rejects(() => s.speak('nope'), (e) => e.code === 'guardrail_blocked');
  assert.equal(socket.didEmit('onTextEntered'), false);
  s.disconnect();
});

// ── LLM10: turn-rate valve ──
test('maxTurnsPerMinute throttles runaway speak()', async () => {
  let now = 1_000_000;
  const { s } = await connected({ maxTurnsPerMinute: 3, now: () => now });
  s._now = () => now;
  for (let i = 0; i < 3; i++) await s.speak('t' + i);
  await assert.rejects(() => s.speak('over'), (e) => e.code === 'rate_limited');
  now += 61000;                       // a minute later the window clears
  await assert.doesNotReject(() => s.speak('ok-now'));
  s.disconnect();
});

// ── LLM06 / Agentic: capability surface + agent-action gate ──
test('capabilities surface reflects clientConfiguration', async () => {
  const { s } = await connected();
  const c = s.capabilities;
  assert.equal(typeof c.screenShare, 'boolean');
  assert.equal(typeof c.webSearch, 'boolean');
  assert.equal(c.interruptions, true);   // happy-path config has interruptionsEnabled:true
  s.disconnect();
});

test('agentActions policy + onAgentAction gate veto an agent action', async () => {
  const denied = [];
  const { s } = await connected({ agentActions: { navigate: 'off' }, onAgentAction: () => true });
  s.on('agentActionDenied', (e) => denied.push(e));
  const allowed = await s._gateAgentAction({ type: 'navigate', payload: { to: 5 } });
  assert.equal(allowed, false, 'navigate vetoed by policy');
  assert.ok(denied.some((d) => d.type === 'navigate'));
  // a different action with onAgentAction allowing it passes
  assert.equal(await s._gateAgentAction({ type: 'render-genui', payload: {} }), true);
  s.disconnect();
});

test('onAgentAction returning false vetoes + audits', async () => {
  const events = [];
  const { s } = await connected({ onAgentAction: (a) => a.type !== 'lead-capture', onAuditEvent: (e) => events.push(e) });
  assert.equal(await s._gateAgentAction({ type: 'lead-capture' }), false);
  assert.equal(await s._gateAgentAction({ type: 'navigate' }), true);
  assert.ok(events.some((e) => e.type === 'agent.action.deny'));
  assert.ok(events.some((e) => e.type === 'agent.action.allow'));
  s.disconnect();
});

// ── W14: the action gate is WIRED into the live agent_raw_text path ──
const rawText = (seg) => ({ delta: JSON.stringify(seg) });

test('gate fires on a flagged agent_raw_text action → brainSegment SUPPRESSED + deny audit', async () => {
  const events = [];
  const segs = [];
  const denied = [];
  const { s, socket } = await connected({ agentActions: { genui: false }, onAuditEvent: (e) => events.push(e) });
  s.on('brainSegment', (d) => segs.push(d));
  s.on('agentActionDenied', (e) => denied.push(e));
  // a real GenUI segment (metadata.runtimeName + `-tool` type) that policy vetoes
  socket.server('agent_raw_text', rawText({ type: 'flashcards-tool', metadata: { runtimeName: 'flashcards-tool' }, content: { cards: [] } }));
  assert.equal(segs.length, 0, 'vetoed action did NOT reach the app as a brainSegment');
  assert.ok(denied.some((d) => d.type === 'render-genui'), 'agentActionDenied emitted');
  assert.ok(events.some((e) => e.type === 'agent.action.deny'), 'deny audited');
  s.disconnect();
});

test('gate ALLOWS a non-vetoed action → brainSegment flows + tool.invoke audit', async () => {
  const events = [];
  const segs = [];
  const { s } = await connected({ agentActions: { genui: false }, onAuditEvent: (e) => events.push(e) });
  s.on('brainSegment', (d) => segs.push(d));
  // sources is render-genui but NOT vetoed by genui:false? genui:false vetoes ALL render-genui;
  // use a policy that only disables navigate so this genui segment is allowed + surfaces tool.invoke.
  s.disconnect();
  const ctx = await connected({ agentActions: { navigate: 'off' }, onAuditEvent: (e) => events.push(e) });
  ctx.s.on('brainSegment', (d) => segs.push(d));
  ctx.socket.server('agent_raw_text', rawText({ type: 'sources-tool', metadata: { runtimeName: 'sources-tool' }, content: { items: [{}] } }));
  await Promise.resolve(); // flush the async _gateAgentAction microtask
  assert.equal(segs.length, 1, 'allowed genui segment reached the app');
  assert.ok(events.some((e) => e.type === 'tool.invoke'), 'tool.invoke surfaced for an allowed genui segment');
  assert.ok(events.some((e) => e.type === 'agent.action.allow'), 'allow audited');
  ctx.s.disconnect();
});

test('DEFAULT-ALLOW: no policy + no hook → spoken AND genui segments flow, no gate audit', async () => {
  const events = [];
  const segs = [];
  const { s, socket } = await connected({ onAuditEvent: (e) => events.push(e) });   // no agentActions, no onAgentAction
  s.on('brainSegment', (d) => segs.push(d));
  socket.server('agent_raw_text', rawText({ type: 'avatar', content: 'hello' }));
  socket.server('agent_raw_text', rawText({ type: 'sources-tool', metadata: { runtimeName: 'sources-tool' }, content: {} }));
  assert.equal(segs.length, 2, 'both segments flow untouched (earnings app unaffected)');
  assert.ok(!events.some((e) => e.type === 'agent.action.allow' || e.type === 'agent.action.deny'), 'no gate audit when ungated');
  s.disconnect();
});

test('onAgentAction veto on a real genui segment suppresses the brainSegment', async () => {
  const segs = [];
  const { s, socket } = await connected({ onAgentAction: (a) => a.type !== 'render-genui' });
  s.on('brainSegment', (d) => segs.push(d));
  socket.server('agent_raw_text', rawText({ type: 'content-gallery-tool', metadata: { runtimeName: 'content-gallery-tool' }, content: {} }));
  assert.equal(segs.length, 0, 'onAgentAction false vetoed the genui segment');
  s.disconnect();
});

// ── W16: micEnabled reflects mute/unmute state ──
test('micEnabled reflects mute/unmute + emits muteUser/unmuteUser', async () => {
  const { s, socket } = await connected();
  assert.equal(s.micEnabled, true, 'starts enabled');
  s.mute();
  assert.equal(s.micEnabled, false);
  assert.equal(socket.didEmit('muteUser'), true);
  s.unmute();
  assert.equal(s.micEnabled, true);
  assert.equal(socket.didEmit('unmuteUser'), true);
  s.disconnect();
});

// ── HIPAA 164.312(a)(2)(iii): idle auto-logoff ──
test('idle auto-logoff disconnects + emits timeExpired{idle_timeout} after inactivity', async () => {
  const { s } = await connected({ idleTimeoutMs: 200 });
  let expiry = null; s.on('timeExpired', (p) => { expiry = p; });
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(s.state, 'disconnected');
  assert.equal(expiry?.type, 'idle_timeout');
});

test('activity resets the idle timer (no premature logoff)', async () => {
  const { s, socket } = await connected({ idleTimeoutMs: 300 });
  let logged = false; s.on('timeExpired', () => { logged = true; });
  await new Promise((r) => setTimeout(r, 180));
  socket.server('userStartedTalking', {});          // activity → resets the clock
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(logged, false, 'still alive — activity reset the idle timer');
  assert.equal(s.state, 'connected');
  s.disconnect();
});

test('idleTimeoutMs:0 disables auto-logoff (documented escape hatch)', async () => {
  const { s } = await connected({ idleTimeoutMs: 0 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.state, 'connected');
  s.disconnect();
});

// ── HIPAA 164.312(a)(2)(i) + (b): subjectId on audit + content-free turn events ──
test('subjectId is stamped on audit events; turn events carry no content', async () => {
  const events = [];
  const { s, socket } = await connected({ subjectId: 'user-opaque-42', onAuditEvent: (e) => events.push(e) });
  socket.server('agentTurnToTalk', { userTranscription: 'my SSN is 123-45-6789' });
  socket.server('stvStartedTalking', {});
  const turnUser = events.find((e) => e.type === 'turn.user_captured');
  const turnAvatar = events.find((e) => e.type === 'turn.avatar_spoke');
  assert.ok(turnUser && turnAvatar, 'content-free turn audit events fired');
  assert.equal(turnUser.actor.subjectId, 'user-opaque-42', 'unique-user-id stamped');
  // CRITICAL: the PHI content must NOT appear in any audit event
  assert.ok(!JSON.stringify(events).includes('123-45-6789'), 'no PHI content in audit stream');
  s.disconnect();
});

// ── LLM05: inbound clamping ──
test('inbound caption is control-char-stripped before reaching the app', async () => {
  const { s, socket } = await connected();
  const caps = [];
  s.on('speechChunk', (c) => caps.push(c.text));
  socket.server('stvSpeechChunk', { text: 'hello world', durationMs: 100, speechId: 'A-x' });
  assert.equal(caps[0], 'helloworld', 'control chars stripped from caption');
  s.disconnect();
});

// ── Avatar/deepfake: disclosure provenance (EU AI Act Art. 50) ──
test('disclosure carries synthetic + provenance; getDisclosure() is queryable', async () => {
  const { s } = await connected();
  const d = s.getDisclosure();
  assert.equal(d.synthetic, true);
  assert.equal(d.provenance.generatedBy, 'ai-avatar');
  assert.equal(d.provenance.voice, 'synthetic');
  assert.ok(d.disclosureText);
  s.disconnect();
});

test('stop() is the human-in-the-loop kill switch (alias of disconnect)', async () => {
  const { s } = await connected();
  s.stop();
  assert.equal(s.state, 'disconnected');
});

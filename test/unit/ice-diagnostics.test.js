// ICE diagnostics: candidate counts, sanitized server errors, selected pair, plain-words cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IceTrace, diagnoseIce } from '../../src/experience/ice-diagnostics.js';
import { FakeRTCPeerConnection } from '../fakes/rtc.js';

const counts = (o = {}) => ({ host: 0, srflx: 0, prflx: 0, relay: 0, ...o });
const diag = (o = {}) => diagnoseIce({ iceConnectionState: 'checking', gatheringState: 'complete', candidates: counts({ host: 1 }), errors: [], ...o });

test('diagnoseIce names the cause for each failure shape', () => {
  assert.equal(diag({ iceConnectionState: 'connected' }).cause, 'connected');
  assert.equal(diag({ iceConnectionState: 'completed' }).cause, 'connected');
  assert.equal(diag({ errors: [{ code: 401, text: '', scheme: 'turn' }] }).cause, 'turn_credentials_rejected');
  assert.equal(diag({ errors: [{ code: 438, text: '', scheme: 'turns' }] }).cause, 'turn_credentials_rejected');
  assert.equal(diag({ errors: [{ code: 701, text: '', scheme: 'turn' }] }).cause, 'turn_unreachable');
  assert.equal(diag({ errors: [{ code: 300, text: '', scheme: 'turn' }] }).cause, 'turn_unreachable');
  assert.equal(diag({ errors: [{ code: 701, text: '', scheme: 'turn' }], candidates: counts({ host: 1, relay: 1 }) }).cause, 'no_route', 'a relay address exists, so the relay is reachable');
  assert.equal(diag({ candidates: counts() }).cause, 'no_candidates');
  assert.equal(diag({ candidates: counts({ relay: 2 }) }).cause, 'no_route');
  assert.equal(diag({ gatheringState: 'gathering' }).cause, 'still_gathering');
  assert.equal(diag().cause, 'no_route');
  assert.match(diag({ errors: [{ code: 701, text: '', scheme: 'turn' }] }).hint, /ports 80 and 443/);
});

test('IceTrace counts local candidates by type and ignores the end marker', () => {
  const pc = new FakeRTCPeerConnection();
  const trace = new IceTrace('stv', pc);
  pc.fireCandidate('host'); pc.fireCandidate('srflx'); pc.fireCandidate('relay'); pc.fireCandidate('relay');
  pc._dispatch('icecandidate', { candidate: null });
  assert.deepEqual(trace.snapshot().candidates, { host: 1, srflx: 1, prflx: 0, relay: 2 });
});

test('IceTrace reads the type from the candidate line when the field is missing', () => {
  const pc = new FakeRTCPeerConnection();
  const trace = new IceTrace('asr', pc);
  pc._dispatch('icecandidate', { candidate: { candidate: 'candidate:1 1 udp 2 10.0.0.2 5000 typ srflx' } });
  assert.equal(trace.snapshot().candidates.srflx, 1);
});

test('IceTrace keeps server errors without any address, and dedupes them', () => {
  const pc = new FakeRTCPeerConnection();
  const trace = new IceTrace('stv', pc);
  pc.fireCandidateError({ errorText: 'Failed to reach 203.0.113.5 and 2001:db8:0:0:0:0:0:1' });
  pc.fireCandidateError({ errorText: 'again' });
  pc.fireCandidateError({ errorCode: 401, url: 'turns:turn.example.com:443?transport=tcp' });
  const snap = trace.snapshot();
  assert.equal(snap.errors.length, 2, 'same code and scheme is stored once');
  assert.deepEqual(snap.errors.map((e) => [e.code, e.scheme]), [[701, 'turn'], [401, 'turns']]);
  const json = JSON.stringify(snap);
  assert.doesNotMatch(json, /203\.0\.113\.5|2001:db8|turn\.example\.com/);
  assert.match(snap.errors[0].text, /<ip>/);
});

test('IceTrace stores at most eight distinct errors and clips long text', () => {
  const pc = new FakeRTCPeerConnection();
  const trace = new IceTrace('stv', pc);
  for (let code = 400; code < 420; code++) pc.fireCandidateError({ errorCode: code, errorText: 'x'.repeat(500) });
  const { errors } = trace.snapshot();
  assert.equal(errors.length, 8);
  assert.ok(errors.every((e) => e.text.length <= 160));
});

test('IceTrace works on a peer without addEventListener', () => {
  const trace = new IceTrace('asr', { iceConnectionState: 'new' });
  const s = trace.snapshot();
  assert.equal(s.iceConnectionState, 'new');
  assert.equal(s.connectionState, 'unknown');
  assert.equal(s.gatheringState, 'unknown');
  assert.equal(s.cause, 'still_gathering');
});

test('report() adds the selected pair from getStats', async () => {
  const pc = new FakeRTCPeerConnection();
  pc.setStats([
    { id: 't', type: 'transport', selectedCandidatePairId: 'p1' },
    { id: 'p1', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' },
    { id: 'r', type: 'remote-candidate', candidateType: 'host' },
  ]);
  const r = await new IceTrace('stv', pc).report();
  assert.deepEqual(r.selectedPair, { localType: 'relay', remoteType: 'host', protocol: 'tcp' });
  assert.equal(r.channel, 'stv');
});

test('report() falls back to a nominated succeeded pair', async () => {
  const pc = new FakeRTCPeerConnection();
  pc.setStats([
    { id: 'p1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'r', type: 'remote-candidate', candidateType: 'srflx' },
  ]);
  assert.deepEqual((await new IceTrace('asr', pc).report()).selectedPair, { localType: 'srflx', remoteType: 'srflx', protocol: 'udp' });
});

test('report() gives a null pair when stats are empty, missing, slow or throw', async () => {
  const empty = new FakeRTCPeerConnection();
  assert.equal((await new IceTrace('stv', empty).report()).selectedPair, null);
  assert.equal((await new IceTrace('stv', { iceConnectionState: 'new' }).report()).selectedPair, null);
  const slow = { iceConnectionState: 'new', getStats: () => new Promise(() => {}) };
  assert.equal((await new IceTrace('stv', slow).report(20)).selectedPair, null);
  const broken = { iceConnectionState: 'new', getStats: () => Promise.reject(new Error('boom')) };
  assert.equal((await new IceTrace('stv', broken).report()).selectedPair, null);
});

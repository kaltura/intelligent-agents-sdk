import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KavaAnalytics, buildPageLoadParams, buildButtonClickedParams,
  DEFAULT_ANALYTICS_URL, EVENT_TYPES, PAGE_TYPES,
} from '../../src/experience/analytics.js';

/**
 * Unit-tests the KAVA analytics plugin in isolation. This module implements ONLY the
 * 10000-range Application Events (pageLoad/buttonClicked) — the 80000-range Immersive
 * Agents events (callStarted/callEnded/messageResponse/messageFeedbackSent) are
 * intentionally absent, since the backend already reports those
 * server-side for every session KalturaAvatarSession connects to; a client-side copy
 * would double-count. These tests prove that absence structurally, not just by omission.
 */

test('EVENT_TYPES exposes exactly the two valid client-side codes', () => {
  assert.deepEqual(EVENT_TYPES, { pageLoad: 10003, buttonClicked: 10002 });
});

test('the module never sends an 80000-range Immersive Agents event — no such export exists', () => {
  const mod = { KavaAnalytics, buildPageLoadParams, buildButtonClickedParams, DEFAULT_ANALYTICS_URL, EVENT_TYPES, PAGE_TYPES };
  const src = Object.keys(mod).join(' ');
  for (const forbidden of ['callStarted', 'callEnded', 'messageResponse', 'messageFeedbackSent', '80001', '80002', '80003', '80004', '80005', '80006']) {
    assert.ok(!src.includes(forbidden), `module surface must not reference ${forbidden}`);
  }
});

test('buildPageLoadParams: builds the exact wire params for a pageLoad (10003) event', () => {
  const params = buildPageLoadParams(
    { partnerId: '6516742', sessionId: 's1' },
    { pageType: 'View', pageName: 'earnings-deck', pageValue: 'slide-3', pageInfo: 'q2-2026' },
  );
  assert.equal(params.service, 'analytics');
  assert.equal(params.action, 'trackEvent');
  assert.equal(params.eventType, '10003');
  assert.equal(params.partnerId, '6516742');
  assert.equal(params.sessionId, 's1');
  assert.equal(params.pageType, 'View');
  assert.equal(params.pageName, 'earnings-deck');
  assert.equal(params.pageValue, 'slide-3');
  assert.equal(params.pageInfo, 'q2-2026');
});

test('buildPageLoadParams: omits undefined optional fields entirely (no "undefined" strings)', () => {
  const params = buildPageLoadParams({ partnerId: '6516742' }, {});
  assert.equal('pageType' in params, false);
  assert.equal('pageName' in params, false);
  assert.equal('ks' in params, false);
  for (const v of Object.values(params)) assert.notEqual(v, 'undefined');
});

test('buildPageLoadParams: rejects a pageType outside the closed enum', () => {
  assert.throws(() => buildPageLoadParams({}, { pageType: 'Bogus' }), /invalid pageType/);
});

test('buildPageLoadParams: accepts every documented pageType', () => {
  for (const pt of PAGE_TYPES) {
    const params = buildPageLoadParams({}, { pageType: pt });
    assert.equal(params.pageType, pt);
  }
});

test('buildButtonClickedParams: builds the exact wire params for a buttonClicked (10002) event', () => {
  const params = buildButtonClickedParams(
    { partnerId: '6516742', entryId: '1_abc' },
    { buttonType: 'Open', buttonName: 'contact-form-submit', buttonValue: 'email', buttonInfo: 'feedback-bubble' },
  );
  assert.equal(params.eventType, '10002');
  assert.equal(params.entryId, '1_abc');
  assert.equal(params.buttonType, 'Open');
  assert.equal(params.buttonName, 'contact-form-submit');
  assert.equal(params.buttonValue, 'email');
  assert.equal(params.buttonInfo, 'feedback-bubble');
});

test('buildButtonClickedParams: buttonType is not validated against a closed enum (spec leaves it open-ended)', () => {
  const params = buildButtonClickedParams({}, { buttonType: 'AnythingGoes' });
  assert.equal(params.buttonType, 'AnythingGoes');
});

// ── KavaAnalytics — the reporter class ──────────────────────────────────────

function mkReporter(overrides = {}) {
  const beaconCalls = [];
  const fetchCalls = [];
  const reporter = new KavaAnalytics({
    partnerId: '6516742', sessionId: 's1',
    sendBeacon: (url, data) => { beaconCalls.push({ url, data }); return true; },
    fetch: async (url, init) => { fetchCalls.push({ url, init }); return { ok: true }; },
    ...overrides,
  });
  return { reporter, beaconCalls, fetchCalls };
}

test('KavaAnalytics.pageLoad: prefers sendBeacon and posts to DEFAULT_ANALYTICS_URL with urlencoded body', async () => {
  const { reporter, beaconCalls, fetchCalls } = mkReporter();
  const res = await reporter.pageLoad({ pageType: 'View', pageName: 'deck' });
  assert.equal(res.ok, true);
  assert.equal(res.transport, 'beacon');
  assert.equal(beaconCalls.length, 1);
  assert.equal(fetchCalls.length, 0);
  assert.equal(beaconCalls[0].url, DEFAULT_ANALYTICS_URL);
  const parsed = new URLSearchParams(beaconCalls[0].data);
  assert.equal(parsed.get('eventType'), '10003');
  assert.equal(parsed.get('pageType'), 'View');
  assert.equal(parsed.get('partnerId'), '6516742');
});

test('KavaAnalytics.buttonClicked: falls back to fetch with keepalive when sendBeacon is unavailable', async () => {
  const { reporter, fetchCalls } = mkReporter({ sendBeacon: undefined });
  const res = await reporter.buttonClicked({ buttonType: 'Open', buttonName: 'cta' });
  assert.equal(res.ok, true);
  assert.equal(res.transport, 'fetch');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].init.keepalive, true);
  const parsed = new URLSearchParams(fetchCalls[0].init.body);
  assert.equal(parsed.get('eventType'), '10002');
  assert.equal(parsed.get('buttonName'), 'cta');
});

test('KavaAnalytics: falls back to fetch when sendBeacon returns false (queue full)', async () => {
  const { reporter, fetchCalls } = mkReporter({ sendBeacon: () => false });
  const res = await reporter.pageLoad();
  assert.equal(res.transport, 'fetch');
  assert.equal(fetchCalls.length, 1);
});

test('KavaAnalytics: enabled:false no-ops without touching beacon or fetch', async () => {
  const { reporter, beaconCalls, fetchCalls } = mkReporter({ enabled: false });
  const res = await reporter.pageLoad();
  assert.equal(res.ok, false);
  assert.equal(res.transport, 'disabled');
  assert.equal(beaconCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test('KavaAnalytics: no transport available reports {ok:false, transport:"none"} rather than throwing', async () => {
  const reporter = new KavaAnalytics({ sendBeacon: undefined, fetch: undefined });
  const res = await reporter.buttonClicked();
  assert.equal(res.ok, false);
  assert.equal(res.transport, 'none');
});

test('KavaAnalytics: a fetch rejection resolves {ok:false} instead of throwing (fire-and-forget, no retry contract)', async () => {
  const reporter = new KavaAnalytics({ sendBeacon: undefined, fetch: async () => { throw new Error('network down'); } });
  const res = await reporter.pageLoad();
  assert.equal(res.ok, false);
  assert.equal(res.transport, 'fetch');
});

test('KavaAnalytics: common params (partnerId/sessionId/hostingKalturaApplication) are attached to every event', async () => {
  const { reporter, beaconCalls } = mkReporter({ hostingKalturaApplication: 28, hostingKalturaApplicationVer: '0.4.1' });
  await reporter.buttonClicked({ buttonName: 'x' });
  const parsed = new URLSearchParams(beaconCalls[0].data);
  assert.equal(parsed.get('partnerId'), '6516742');
  assert.equal(parsed.get('sessionId'), 's1');
  assert.equal(parsed.get('hostingKalturaApplication'), '28');
  assert.equal(parsed.get('hostingKalturaApplicationVer'), '0.4.1');
});

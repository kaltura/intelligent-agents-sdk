/**
 * One `KalturaAvatarSession` wired to the fakes, for e2e tests that drive the
 * connect handshake offline. Every fake is swappable through `overrides`.
 */
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket } from './socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from './rtc.js';

/** A conversation KS shaped like the real one (`v2|<partner>|geniegpcid:<configId>`), fake values. */
export const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** A WHEP `fetch` that answers the subscribe with a 201 and a resource URL. */
export const okWhep = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });

/**
 * Build a session on fresh fakes. Resets `FakeRTCPeerConnection.instances`.
 *
 * `overrides.videoEl` may be `null` to test audio mode; omit it for a
 * `FakeVideoEl` that auto-fires canplay. `overrides.cfg` is spread last, so
 * it wins over every default (e.g. `{ micStartMode: 'deferred' }`).
 *
 * @param {{videoEl?: object|null, fetch?: Function, getUserMedia?: Function, rtcConstructor?: Function, cfg?: object}} [overrides]
 */
export function newAvatarSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = 'videoEl' in overrides ? overrides.videoEl : new FakeVideoEl({ autoCanPlay: true });
  const getUserMedia = overrides.getUserMedia ?? fakeGetUserMedia();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl, socketFactory: () => socket, rtcConstructor: overrides.rtcConstructor ?? FakeRTCPeerConnection,
    fetch: overrides.fetch ?? okWhep, getUserMedia,
    mediaStreamConstructor: FakeMediaStreamCtor,
    ...overrides.cfg,
  });
  return { session, socket, videoEl, getUserMedia };
}

/**
 * The ASR peer among the fakes. The STV (WHEP) peer is created first, in
 * parallel with the agent wait, so pick by shape (no video transceiver)
 * rather than by creation order.
 */
export const asrPeer = () => FakeRTCPeerConnection.instances.find((pc) => !pc.transceivers.some((t) => t.kind === 'video'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateOrLoopbackHost, PRIVATE_IP_RE } from '../../src/core/net-guard.js';

/** core/net-guard.js — the shared SSRF/private-network host predicate + log-scrub regex. */

test('isPrivateOrLoopbackHost flags RFC1918 ranges, loopback, and link-local (incl. cloud-metadata IP)', () => {
  assert.equal(isPrivateOrLoopbackHost('10.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('172.31.255.255'), true);
  assert.equal(isPrivateOrLoopbackHost('192.168.1.1'), true);
  assert.equal(isPrivateOrLoopbackHost('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('127.5.5.5'), true); // whole 127/8 block, not just .0.0.1
  assert.equal(isPrivateOrLoopbackHost('169.254.169.254'), true); // cloud-metadata SSRF target
});

test('isPrivateOrLoopbackHost flags localhost and IPv6 loopback in bare/bracketed form', () => {
  assert.equal(isPrivateOrLoopbackHost('localhost'), true);
  assert.equal(isPrivateOrLoopbackHost('LOCALHOST'), true);
  assert.equal(isPrivateOrLoopbackHost('::1'), true);
  assert.equal(isPrivateOrLoopbackHost('[::1]'), true);
});

test('isPrivateOrLoopbackHost flags IPv4-mapped IPv6 loopback (bracketed URL and bare literal)', () => {
  assert.equal(isPrivateOrLoopbackHost('http://[::ffff:127.0.0.1]/'), true);
  assert.equal(isPrivateOrLoopbackHost('::ffff:127.0.0.1'), true);
  // Public IPv4 mapped into IPv6 must NOT be flagged.
  assert.equal(isPrivateOrLoopbackHost('http://[::ffff:8.8.8.8]/'), false);
});

test('isPrivateOrLoopbackHost flags IPv6 unique-local (fc00::/7) and link-local (fe80::/10)', () => {
  assert.equal(isPrivateOrLoopbackHost('fc00::1'), true);
  assert.equal(isPrivateOrLoopbackHost('[fc00::1]'), true);
  assert.equal(isPrivateOrLoopbackHost('fe80::1'), true);
  assert.equal(isPrivateOrLoopbackHost('[fe80::1]'), true);
  // Outside either range must NOT be flagged.
  assert.equal(isPrivateOrLoopbackHost('fec0::1'), false);
  assert.equal(isPrivateOrLoopbackHost('2001:4860:4860::8888'), false);
});

test('isPrivateOrLoopbackHost still flags obfuscated IPv4 loopback (decimal/hex/octal), via URL hostname normalization', () => {
  assert.equal(isPrivateOrLoopbackHost('http://2130706433/'), true); // decimal
  assert.equal(isPrivateOrLoopbackHost('http://0x7f.0.0.1/'), true); // hex
  assert.equal(isPrivateOrLoopbackHost('http://0177.0.0.1/'), true); // octal
});

test('isPrivateOrLoopbackHost accepts a full URL and checks its hostname', () => {
  assert.equal(isPrivateOrLoopbackHost('http://192.168.0.5:8080/path'), true);
  assert.equal(isPrivateOrLoopbackHost('https://localhost:3000/'), true);
  assert.equal(isPrivateOrLoopbackHost('https://example.com/'), false);
});

test('isPrivateOrLoopbackHost accepts a bare host[:port]', () => {
  assert.equal(isPrivateOrLoopbackHost('10.0.0.1:9200'), true);
  assert.equal(isPrivateOrLoopbackHost('example.com:443'), false);
});

test('isPrivateOrLoopbackHost is false for public hosts/IPs and never throws on odd input', () => {
  assert.equal(isPrivateOrLoopbackHost('example.com'), false);
  assert.equal(isPrivateOrLoopbackHost('8.8.8.8'), false);
  assert.equal(isPrivateOrLoopbackHost(''), false);
  assert.equal(isPrivateOrLoopbackHost(null), false);
  assert.equal(isPrivateOrLoopbackHost(undefined), false);
  assert.equal(isPrivateOrLoopbackHost(42), false);
});

test('PRIVATE_IP_RE scrubs private IPv4 literals from free text, global + word-bounded', () => {
  const text = 'connect to 10.0.0.1 or 192.168.1.1 but not 8.8.8.8';
  const scrubbed = text.replace(PRIVATE_IP_RE, '<private-ip>');
  assert.equal(scrubbed, 'connect to <private-ip> or <private-ip> but not 8.8.8.8');
});

test('PRIVATE_IP_RE does NOT match the word "localhost" or the IPv6 literal "::1" (hostnames, not octets)', () => {
  const text = 'reach it at localhost or ::1 for local dev';
  assert.equal(PRIVATE_IP_RE.test(text), false);
});

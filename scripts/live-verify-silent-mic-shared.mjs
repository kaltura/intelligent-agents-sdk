/**
 * Silent fake microphone input for live scripts that assert on what the agent
 * says back.
 *
 * Chromium's `--use-fake-device-for-media-stream` plays a 440 Hz tone. Speech
 * recognition turns that tone into a stream of invented user turns, which take
 * the floor and barge in on the reply the script is waiting for, so an
 * assertion about the agent's own words fails for a reason that has nothing to
 * do with the code under test. `--use-file-for-fake-audio-capture=<wav>` keeps
 * the whole mic path real (getUserMedia, the ASR peer, VAD) with nothing for
 * the recognizer to invent words out of.
 *
 * Shared by scripts/live-verify-set-forced-language.mjs and
 * scripts/live-verify-context-fields.mjs.
 */
import { writeFileSync } from 'node:fs';

/**
 * Write a 1 second, 48 kHz, 16-bit mono PCM WAV of pure silence. Chromium
 * loops it for as long as the page holds the mic.
 *
 * @param {string} path Destination for the generated file.
 * @returns {string} The same path, for use in a Chromium launch flag.
 */
export function writeSilentWav(path) {
  const rate = 48000;
  const dataLen = rate * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);   // PCM header size
  buf.writeUInt16LE(1, 20);    // format: PCM
  buf.writeUInt16LE(1, 22);    // channels
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);    // block align
  buf.writeUInt16LE(16, 34);   // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  writeFileSync(path, buf);
  return path;
}

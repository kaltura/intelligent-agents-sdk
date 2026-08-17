/**
 * Scripted-video (STV-only) session: a brain-free avatar that speaks exactly
 * the audio you hand it, driven entirely from your own server. No LLM, no
 * ASR, no socket.io. Run:
 *
 *   AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… AVATAR_ID=… node examples/scripted-video-session.mjs
 *
 * then open http://localhost:8790 — Start Session, type something, Speak.
 *
 * `AVATAR_ID` is a 24-char avatar id from your catalog (see
 * `mgmt.avatars.list(ks).all()`, or Phase 1 of API-REFERENCE.md to create one).
 *
 * This example has no TTS provider wired in on purpose — the SDK doesn't
 * ship one (there is no native TTS on this backend; see API-REFERENCE.md §
 * Scripted-Video Sessions). `synthesizeTone()` below stands in for your real
 * TTS call: swap it for ElevenLabs/Polly/etc, which returns real speech
 * audio bytes AND lets you read/measure the real duration.
 *
 * NOTE (dev-local path): the import below resolves against the repo's src/
 * tree. npm consumers should import from '@kaltura/intelligent-agents/management'
 * and '@kaltura/intelligent-agents/experience' instead.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Management } from '../src/management/index.js';

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
const avatarId = process.env.AVATAR_ID;
if (!partnerId || !adminSecret || !avatarId) {
  console.error('Set AGENTIC_PARTNER_ID + AGENTIC_ADMIN_SECRET + AVATAR_ID');
  process.exit(2);
}

const kaltura = new Management({ partnerId, adminSecret });

/** @type {{sessionId:string, token:string, isExpired:()=>boolean}|null} */
let current = null;

/**
 * Stand-in for a real TTS call: a pure-sine-wave 16-bit PCM WAV, long enough
 * to read the text aloud at a rough speaking pace. Swap this for your TTS
 * provider — the point this example demonstrates is the session/say-audio
 * wiring, not speech synthesis.
 * @param {string} text @returns {{wav:Buffer, durationSeconds:number}}
 */
function synthesizeTone(text) {
  const sampleRate = 8000;
  const durationSeconds = Math.min(6, Math.max(1, text.length * 0.06));
  const frameCount = Math.round(sampleRate * durationSeconds);
  const data = Buffer.alloc(frameCount * 2);
  for (let i = 0; i < frameCount; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3 * 32767;
    data.writeInt16LE(Math.round(sample), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);   // block align
  header.writeUInt16LE(16, 34);  // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([header, data]), durationSeconds };
}

async function startSession() {
  const admin = await kaltura.sessions.createAdminToken({ ttlSeconds: 3600 });
  const session = await kaltura.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
  const { whepUrl, turn } = await kaltura.avatarSessions.initClient(session);
  current = session;
  return { whepUrl, turn }; // non-secret — safe to send the browser
}

async function speak(text) {
  if (!current) throw new Error('no active session — call /api/start first');
  const { wav, durationSeconds } = synthesizeTone(text);
  await kaltura.avatarSessions.say(current, wav, { duration: durationSeconds, mimeType: 'audio/wav' });
  return { durationSeconds };
}

async function endSession() {
  if (!current) return;
  await kaltura.avatarSessions.end(current);
  current = null;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = readFileSync(new URL('./scripted-video-session.html', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/start') return sendJson(res, 200, await startSession());
    if (req.method === 'POST' && req.url === '/api/speak') {
      const { text } = await readJsonBody(req);
      if (!text || !text.trim()) return sendJson(res, 400, { error: 'text is required' });
      return sendJson(res, 200, await speak(text.trim()));
    }
    if (req.method === 'POST' && req.url === '/api/end') { await endSession(); return sendJson(res, 200, { ok: true }); }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

process.on('SIGINT', async () => { await endSession().catch(() => {}); process.exit(0); });

const PORT = 8790;
server.listen(PORT, () => console.log(`Scripted-video example at http://localhost:${PORT}`));

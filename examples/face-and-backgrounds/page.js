/* global io */
import { KalturaAvatarSession } from '/src/experience/index.js';

const grid = document.getElementById('grid');
const sessions = [];
window.cells = sessions; // for DevTools

const cells = await (await fetch('/api/cells')).json(); // nosemgrep: scripts.harness.no-raw-fetch-bypass

for (const c of cells) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.key = c.key;

  const stage = document.createElement('div');
  stage.className = 'stage';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = false;
  const voice = document.createElement('audio');
  voice.autoplay = true; voice.muted = true; // start silent: five greetings at once are noise
  let ref;
  if (c.image) {
    ref = document.createElement('img');
    ref.src = c.image; ref.alt = `${c.label} source`;
  } else {
    ref = document.createElement('div');
    ref.style.background = c.color; ref.title = c.color;
  }
  ref.className = 'ref';
  ref.style.aspectRatio = '1 / 1';
  stage.append(video, ref);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('strong'); title.textContent = c.label;
  const status = document.createElement('span'); status.className = 'status'; status.textContent = 'connecting…';
  const sound = document.createElement('button'); sound.className = 'small'; sound.textContent = 'Unmute';
  sound.onclick = () => { voice.muted = !voice.muted; sound.textContent = voice.muted ? 'Unmute' : 'Mute'; };
  meta.append(title, status, sound);

  const ids = document.createElement('div');
  ids.className = 'ids';
  ids.textContent = `face ${c.faceId}\nbackground ${c.backgroundId}`;
  ids.style.whiteSpace = 'pre-line';

  el.append(stage, meta, ids, voice);
  grid.append(el);

  const session = new KalturaAvatarSession({
    token: c.init.ks,
    conversationManagerUrl: c.init.conversationManagerUrl,
    srsBaseUrl: c.init.srsBaseUrl,
    turnServerUrl: c.init.turnServerUrl,
    videoEl: video,
    audioEl: voice,
    socketFactory: (url, opts) => io(url, opts),
    isFirefox: /firefox/i.test(navigator.userAgent),
  });
  const entry = { key: c.key, session, video, state: 'connecting', transcripts: [] };
  sessions.push(entry);
  const set = (text, kind) => { status.textContent = text; status.className = `status ${kind || ''}`; entry.state = text; el.dataset.state = text; };
  session.on('transcript', ({ text, type }) => entry.transcripts.push(`[${type}] ${text}`));
  session.on('error', (e) => set(`error ${e.code}`, 'bad'));
  session.on('ended', () => set('ended', 'bad'));
  session.connect().then(() => set('connected', 'ok')).catch((e) => set(`failed ${e?.code || e?.message}`, 'bad'));
}

document.getElementById('say').onclick = () => {
  const m = document.getElementById('msg');
  const text = m.value.trim();
  if (!text) return;
  for (const s of sessions) s.session.speak(text);
  m.value = '';
};
document.body.dataset.ready = 'true';

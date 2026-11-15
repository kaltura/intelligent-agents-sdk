# Recipe: Hear how a voice says your text

Record a voice saying exact scripts, so you can judge pronunciation by ear. For builders who write spoken forms for numbers, acronyms and names (see [Write for speech](DOCTOR.md#write-for-speech)). A transcript cannot tell a spelled-out acronym from a word, so only listening settles it.

## How it works

The avatar speaks the intellect's `opening_phrase` word for word when a session starts. A throwaway agent on the voice under test, one fresh session per script, gives you one clip each.

| Step | Where | What |
|---|---|---|
| 1 | Server | Create a test intellect and a test agent on the avatar that carries the voice |
| 2 | Server | For each script, set it as the `opening_phrase` |
| 3 | Browser | Open a session on the test agent and record the avatar's audio track |
| 4 | You | Listen. Rate each clip |
| 5 | Server | Delete the test agent and intellect |

## 1. Create the test agent

```js
const { configId } = await mgmt.intellects.create({ type: 'internal', status: 2, name: 'ear test', base_directive: 'You are a voice test. Say nothing but your opening phrase.', opening_phrase: 'Ready.' }, ks);
const { agentId } = await mgmt.agents.create({ displayName: 'ear test', intellect: { intellectType: 'genie', id: configId }, avatarIds: [avatarId], adminTags: ['ear-test'] }, ks);
const { widgetId } = await mgmt.application.resolveWidgetId(agentId, ks);
```

## 2. Set the script, record the clip

Before each clip, write the script:

```js
await mgmt.intellectConfig.setOpeningPhrase(configId, script, ks);
```

`opening_phrase` is a template, so a script must not contain `{{` or `{%`.

In a browser page (the session setup is the one in [examples/browser-experience.html](../examples/browser-experience.html)), record the audio track when it arrives:

```js
const chunks = [];
const said = [];
let recorder;
session.on('track', ({ track }) => {
  if (track.kind !== 'audio') return;
  recorder = new MediaRecorder(new MediaStream([track]), { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.start();
});
session.on('transcript', ({ type, text }) => { if (type === 'final') said.push(text); });
const finished = new Promise((resolve) => session.on('avatarStopTalking', () => setTimeout(resolve, 800)));
await session.connect();                 // the avatar speaks the opening phrase now
await finished;
const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
recorder.stop();
await stopped;
await session.disconnect();
const clip = new Blob(chunks, { type: 'audio/webm' });
```

Pass `audioEl` to the session so the browser plays the voice. Run each script in a fresh page or session, and in an automated browser start it with `--use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required`.

## 3. Check and clean up

| Check | Why |
|---|---|
| `said.join(' ')` equals the script | A clip where the avatar said something else is not a test of your script. Run it again |
| Judge by ear, blind to the variant | Rate each clip, with the raw form and the spoken form shuffled |

```js
await mgmt.agents.delete(agentId, ks, { confirmPermanent: true });
await mgmt.intellects.delete(configId, ks, { confirmPermanent: true });
```

A clip takes about 6 to 8 seconds. This is a listening test of a voice, not a way to deliver scripted speech to users.

> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Limited Availability

Features the SDK supports before every environment has them. **Employee or certified partner only.** Each feature is opt-in. An app that does not use it is unaffected.

| Feature | Where | Default |
|---|---|---|
| Avatar emotions in the reply stream | Capability `avatar_emotions` | Off |
| Avatar emotions setting | `emotions` on `avatars.create` and `avatars.update` | Not sent |

The capability name `avatar_emotions` appears in no user doc, no docs site page and no assistant knowledge base. `node tools/check-docs.mjs` enforces that. Keep the `emotions` avatar setting out of those places by review. The list lives in `LIMITED_AVAILABILITY_CAPABILITIES` in `src/management/capabilities.js`.

## Environments without the feature

A server without the feature can refuse the capability. The SDK accepts the name and never adds it by itself, so send it only when you opt in. The same holds for the `emotions` avatar field: a server without the feature can refuse it.

## Avatar emotions in the stream

With `avatar` and `avatar_emotions` both on, avatar chunks carry the emotion of the speech.

| Fact | Detail |
|---|---|
| Labels | `neutral`, `happy`, `sad`, `surprise` |
| Where | `metadata.emotion` on the `segmentStart` chunk of a `type:"avatar"` segment |
| Split | Each emotion change starts a new avatar segment |
| Off | `metadata` is absent from avatar chunks |
| Needs | `avatar` on. The SDK does not check this. The server decides |
| SDK | Passes the value through unchanged, including an unknown label |

Match the label against the four above before you use it. Treat it as untrusted text.

```json
{"type":"avatar","content":"Oh no.","segmentStart":true,"metadata":{"emotion":"sad"}}
{"type":"avatar","content":" That sounds hard.","segmentEnd":true}
{"type":"avatar","content":"But it will get better!","segmentStart":true,"metadata":{"emotion":"happy"}}
```

The JSDoc type is `AvatarEmotion` in `src/core/stream.js`.

### Turn it on

Per message:

```js
const conv = await kaltura.sessions.createConversationToken({ configId });
const reply = await kaltura.conversations.send(
  { userMessage: 'Tell me a sad story, then cheer me up.', capabilities: { avatar: 'on', avatar_emotions: 'on' } },
  conv.ks,
);
```

Or store it on the agent's intellect with `intellects.setCapability(configId, 'avatar_emotions', 'on', adminKs)`. A stored `disabled` still wins over a per-message `on`.

### Read the labels

```js
const labels = [];
for await (const seg of kaltura.conversations.stream({ userMessage, capabilities: { avatar: 'on', avatar_emotions: 'on' } }, conv.ks)) {
  if (seg.type === 'avatar' && seg.segmentStart && seg.metadata?.emotion) labels.push(seg.metadata.emotion);
}
```

## Avatar emotions setting

`avatars.create` and `avatars.update` accept `emotions`. The SDK checks types before the request. The server checks which labels exist.

| Key | Type | Rule |
|---|---|---|
| `enabled` | boolean | |
| `intensity` | number | Finite, 0 to 1 |
| `allowed` | string[] | Non-empty strings, no repeats. `[]` clears the list |

Rules:

- Omit a key to keep its stored value.
- `null` is refused offline. Send `allowed: []` to clear.
- An unknown key is refused offline.

```js
await kaltura.avatars.update({ id: avatarId, emotions: { enabled: true, intensity: 0.6, allowed: ['happy', 'sad'] } }, adminKs);
```

## Verify live

```bash
TARGET=<name> node scripts/live-verify-emotions.mjs
```

`TARGET` is required, so a run never reaches an environment by accident. Set it to the name of the Limited Availability environment. The script needs that environment's credentials. It creates a throwaway agent and avatar, runs three trials with emotions on and one control with them off, and deletes everything. It passes when all of these hold:

- At least two of three trials show two or more distinct labels over two or more avatar segments.
- The control shows no labels and has a non-empty reply.
- The avatar `emotions` setting round-trips on `create`, `get` and `update`.

CI has no credentials for this environment, so the script is not part of any workflow.

For a statistical check of the output, run the [emotions eval](emotions-eval.md).

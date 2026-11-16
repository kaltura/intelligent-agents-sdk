> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Limited Availability

Features the SDK supports before every environment has them. **Employee or certified partner only.** A feature is either opt-in or automatic: automatic ones act only when the server sends the new data, and an environment that does not is unaffected.

| Feature | Where | Default |
|---|---|---|
| Avatar emotions in the reply stream | Capability `avatar_emotions` | Off |
| Avatar emotions setting | `emotions` on `avatars.create` and `avatars.update` | Not sent |
| Per-session TURN credentials | `turn` in the connect handshake, read by `normalizeServerTurn` and `iceServersFor` | Automatic when the server sends them |

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

## Per-session TURN credentials

Automatic. No option. A server that sends no `turn` behaves as before. To check an environment, run `node scripts/live-verify-turn.mjs --env <name> --env-file ../.env --expect-server-turn yes`. Use `no` for one that does not send them. The script asserts that the peers hold the server entry (or do not) and that no secret reaches logs, events or errors.

**Where the SDK reads `turn`.** `onServerConnected`, `clientConfiguration`, `joinComplete` and `stvNewSession`. It also reads any event named for TURN or ICE servers (for example `turnCredentials`, `iceServers`), from `payload.turn` or the whole payload. `turn` is `{ url, username, credential, ttl }`, `ttl` in seconds. `KalturaScriptedVideoSession` takes the same forms.

**Entries.** The server entry is listed first, `turnServerUrl` second. Both are gathered in parallel, so a session connects on whichever the relay accepts.

- When both name the same UDP relay address, each address goes to one entry only. The server entry keeps UDP 443, the configured entry keeps UDP 80. Browsers share one socket per UDP relay address, so a refused entry would block the other one's UDP relay. TCP and TLS URLs stay in both. The SDK compares host names, so an IP or alias for the same relay is not split.
- A `turn` with an empty or missing `url` uses the `turnServerUrl` host, unless the app passes `turnCredentials`. Then the server entry is ignored. A later `turn` with no `url` keeps the earlier host.
- `turnCredentials` for a host the server entry does not name are used alone. The SDK reads `turnCredentials` once, when the session is created.
- Credentials that arrive while peers exist are applied in place and take effect at the next ICE restart.

**Refusal.** A browser refusal or a 401 on a URL only one entry uses sets that entry aside for later peers, with one `[turn]` warning. Firefox reports the error URL without its transport, so the SDK acts only on an unambiguous URL. With no `turnServerUrl` and no server entry, the logger gets one `[turn]` warning.

**Renewal.** When a peer is about to need a new relay allocation (`resume()` after a long pause, a media recovery, `connect()` after `prepare()`) and the credentials expire within a minute, the SDK opens a fresh socket first to get new ones. It needs an expiry known at receipt, more than 120 s ahead, a server entry that peers actually use, and runs once per credential set. `resume()` takes the cold path then, so the app sees `reconnecting` and the opening line plays again.

**Secrets.** No secret reaches logs, events, errors or `session.clientConfig`. They are dropped at session end.

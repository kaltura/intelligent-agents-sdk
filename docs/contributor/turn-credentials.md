> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Per-session TURN credentials

How apps use them: [audio-channels.md §5](../wire-protocol/audio-channels.md#5-asr-uplink-pc1-microphone--server). This page holds what only a contributor needs.

## Verify an environment

```bash
node scripts/live-verify-turn.mjs --env <name> --env-file ../.env --expect-server-turn yes
```

Use `no` for an environment that does not send them. The script asserts that the peers hold the server entry (or do not) and that no secret reaches logs, events or errors. It needs credentials for the target environment, so it is for employees and certified partners. CI has none.

## Where the SDK reads `turn`

`onServerConnected`, `clientConfiguration`, `joinComplete` and `stvNewSession`. It also reads any event named for TURN or ICE servers (for example `turnCredentials`, `iceServers`), from `payload.turn` or the whole payload. `turn` is `{ url, username, credential, ttl }`, `ttl` in seconds. `KalturaScriptedVideoSession` takes the same forms.

## Renewal

`resume()` takes the cold path when it renews, so the app sees `reconnecting` and the opening line plays again. Renewal needs an expiry known at receipt, more than 120 s ahead, and a server entry that new peers actually use. It runs once per credential set.

## Secrets

No secret reaches logs, events, errors or `session.clientConfig`. The SDK drops them at session end. Keep it that way: assert it in any new test that touches `turn`.

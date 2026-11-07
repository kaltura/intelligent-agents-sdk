> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](../../docs/contributor/README.md).

# Feature pages

Small pages that show recent SDK behavior in a real browser, on a throwaway agent. Use them to look at a feature by hand, on any device. `npm run live-verify:feature-pages` clicks through the same pages in Chromium, Firefox and WebKit.

## Start

```bash
export NVP1_AGENTIC_PARTNER_ID=... NVP1_AGENTIC_ADMIN_SECRET=...   # or AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET
node manual-testing/feature-pages/serve.mjs --lan
```

It creates one agent, prints an `Open:` URL and waits. Ctrl+C, or the time limit (`--ttl-minutes`, default 60), deletes the agent, its threads and the catalog item, then checks they are gone. `--env-file PATH` (or `ENV_FILE`) loads a `.env` you name. `--port N` fixes the port. Without `--lan` it listens on 127.0.0.1 only.

## Pages

| Page | What you see |
|---|---|
| `connect-errors` | A refused connect shows `code` `unsupported_client` and the server's reason in `serverCode`. Two form-value calls print the one-time notice once |
| `side-question` | A question asked without saving leaves the thread's message count unchanged. Continuing from a saved answer makes a new thread and leaves the source alone |
| `catalog-scope` | A custom visual with an agent scope is listed for that scope only. Move it, clear it, and the lists change |
| `variables` | The agent's system and custom `{{variables}}` |
| `request-vars` | A `sys__` key is refused before any network call. A custom key reaches the agent |
| `emotions` | Emotion label per avatar segment, with the setting on and off |

## Emotions page

It needs a Limited Availability environment and is for Kaltura employees and certified partners only. It is not in the default run. Set `TARGET` to the environment name, with no default:

```bash
TARGET=<name> node manual-testing/feature-pages/serve.mjs --emotions
```

`TARGET=<name> npm run live-verify:feature-pages` drives it the same way. Without `TARGET` the script never touches it.

## Safety

- The admin secret and admin tokens stay in `serve.mjs`. A page gets one conversation token and the base URLs.
- Every URL starts with a random 128-bit path. Anyone with the URL can use the agent until you stop the server, so share it only on a network you trust.
- Pages send a strict Content-Security-Policy. All page code is in external files.
- Screenshots and the server log go to `out/` (git-ignored). Pages never show tokens, and the log is redacted.

#!/usr/bin/env node
/**
 * Manual cross-browser/device test harness for the real avatar pipeline
 * (mic capture → ASR uplink → STV/WHEP video downlink → chroma-key
 * compositing) — see manual-testing/voice-video/README.md for the full test
 * plan and for exactly which parts of this are already covered by
 * automation (scripts/live-verify-browser.mjs, .github/workflows/live-verify.yml)
 * versus what only a real device/browser/network can exercise.
 *
 * Provisions a throwaway agent+avatar+intellect, serves the real unmodified
 * examples/chroma-key-avatar.html plus a real /appInit route over the LAN,
 * and prints a URL to open on each test device.
 *
 * Ctrl+C when done: deletes the throwaway agent/avatar/intellect and exits.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
 */
import { Management } from '../../src/management/index.js';
import { loadCredentials, startServer, reportListenError, lanAddress, PORT, FOUR_HOURS } from './serve.mjs';

const kaltura = new Management(loadCredentials());
let server;
/** @type {any} */
let provisioned = null;

async function cleanup() {
  console.log('\nShutting down…');
  if (server) await new Promise((r) => server.close(r));
  if (provisioned) {
    const admin = await kaltura.sessions.createAdminToken().catch(() => null);
    if (admin) {
      await kaltura.agents.delete(provisioned.agentId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('agent delete failed:', err?.message || err));
      await kaltura.avatars.delete(provisioned.avatarId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('avatar delete failed:', err?.message || err));
      await kaltura.intellects.delete(provisioned.configId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('intellect delete failed:', err?.message || err));
      console.log(`Deleted throwaway agent/avatar/intellect (${provisioned.agentId}).`);
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const admin = await kaltura.sessions.createAdminToken({ ttlSeconds: FOUR_HOURS });
// MANUAL_VERIFY_VISUAL_ID: a Visual catalog item id (`catalog.list`) to use instead of the first preset,
// e.g. a green-screen portrait so the chroma-key example has something to key.
provisioned = await kaltura.provision({ brief: 'A friendly manual-QA greeter avatar', ks: admin.ks, visualId: process.env.MANUAL_VERIFY_VISUAL_ID || undefined });
console.log(`Throwaway agent/avatar/intellect: ${provisioned.agentId} / ${provisioned.avatarId} / ${provisioned.configId}`);

let widgetId = provisioned.widgetId;
if (!widgetId) widgetId = (await kaltura.application.resolveWidgetId(provisioned.agentId, admin.ks))?.widgetId;
const widget = await kaltura.sessions.createWidgetToken({ widgetId, ttlSeconds: FOUR_HOURS });
const init = await kaltura.application.appInit(widget.ks);

try {
  server = await startServer(init);
} catch (err) {
  reportListenError(err);
  await cleanup();
  process.exit(1);
}

const url = `http://${lanAddress()}:${PORT}/examples/chroma-key-avatar.html`;

console.log('');
console.log('Open this URL on each test device (same Wi-Fi network):');
console.log('');
console.log(`  ${url}`);
console.log('');
console.log('For a device that can\'t reach your LAN, tunnel this port instead (e.g. `ngrok http 4789`) and use the tunnel URL.');
console.log('Ctrl+C to finish and delete the throwaway agent/avatar/intellect.');
console.log('');

/**
 * navigate_to_page client-tool handler — Nova drives real in-site navigation
 * herself via router.js rather than just telling visitors where to click.
 * Must be registered BEFORE session.connect() (see connect.js), mirroring the
 * SDK's own Presenter navigate_to_slide pattern: a one-nav-per-turn guard
 * (a brain "restart" can otherwise fire two different nav targets in one
 * turn) plus a short duplicate-suppression window for a repeated identical
 * target. Unlike navigate_to_slide this tool is `waitForResponse:true`, so
 * every branch acks via session.respondToTool — a silently-swallowed ack
 * would otherwise leave the brain narrating a nav that never happened. If
 * the resolved target is wherever the visitor already is, acks
 * `alreadyHere:true` and skips navigateTo() — otherwise Nova narrates a
 * fresh navigation to a page the visitor never actually left.
 */
import { resolveRoute, withPrefix, navigateTo, currentRoute } from './router.js';

const DUP_SUPPRESS_MS = 3000;

export function initNavigator(session) {
  let turnSpeechId;
  let turnNavFiredFor;
  let lastPath = null;
  let lastNavTime = 0;

  session.on('turnStart', (p) => {
    if (p?.isNewTurn) turnSpeechId = p.speechId || null;
  });

  session.onToolCall('navigate_to_page', async (args, call) => {
    const id = call?.toolMetadata?.id;
    const ack = (response) => (id ? session.respondToTool(id, response) : Promise.resolve());

    if (turnNavFiredFor === turnSpeechId) {
      await ack({ ok: false, error: 'suppressed_second_nav_this_turn' });
      return;
    }

    const resolved = resolveRoute(typeof args?.path === 'string' ? args.path : '');
    if (!resolved) {
      await ack({ ok: false, error: 'not_found' });
      return;
    }

    if (resolved === currentRoute()) {
      await ack({ ok: true, path: resolved, alreadyHere: true });
      return;
    }

    const now = Date.now();
    if (resolved === lastPath && now - lastNavTime < DUP_SUPPRESS_MS) {
      await ack({ ok: true, path: resolved });
      return;
    }

    turnNavFiredFor = turnSpeechId;
    lastPath = resolved;
    lastNavTime = now;

    await ack({ ok: true, path: resolved });
    navigateTo(withPrefix(resolved));
  });
}

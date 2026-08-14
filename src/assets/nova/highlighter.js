/**
 * highlight_element client-tool handler + per-page target feed. Scans the
 * live <main> for [data-nova-target] elements on every nova:pagechange (and
 * once at initial connect) and pushes the current page's {id,label} list to
 * the brain via session.setDynamicPrompt — mirroring how the SDK's own
 * Presenter plugin feeds per-slide DPP content, so the model is only ever
 * told about targets that actually exist on the page it's grounded on right
 * now. Like navigate_to_page this tool is `waitForResponse:true`: a found/
 * not-found ack is what lets the brain tell the truth about whether it
 * actually pointed at something, rather than a silently-swallowed miss it
 * could still narrate as a success.
 */
import { pointAt } from './dock.js';

function currentTargets() {
  return [...document.querySelectorAll('main.content-wrapper [data-nova-target]')].map((el) => ({
    id: el.getAttribute('data-nova-target'),
    label: el.getAttribute('data-nova-label') || '',
  }));
}

export function initHighlighter(session) {
  function pushTargets() {
    if (session.state !== 'connected') return;
    session.setDynamicPrompt({ highlightable_elements: currentTargets() });
  }

  session.on('stateChange', ({ state }) => {
    if (state === 'connected') pushTargets();
  });
  document.addEventListener('nova:pagechange', pushTargets);

  session.onToolCall('highlight_element', async (args, call) => {
    const id = call?.toolMetadata?.id;
    const ack = (response) => (id ? session.respondToTool(id, response) : Promise.resolve());

    const target = typeof args?.target === 'string' ? args.target : '';
    if (!target) {
      await ack({ ok: false, error: 'not_found' });
      return;
    }
    const el = document.querySelector(`main.content-wrapper [data-nova-target="${CSS.escape(target)}"]`);
    if (!el) {
      await ack({ ok: false, error: 'not_found' });
      return;
    }
    await ack({ ok: true, target });
    pointAt(el);
  });
}

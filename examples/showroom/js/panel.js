/**
 * The right-hand (or top) panel: tabs, the current scene, and a voice hint.
 * Re-renders on every state change but keeps keyboard focus, and only plays
 * the enter animation when the screen itself changes.
 */
import { h, clear, usd } from './dom.js';
import { mountWidget } from '../../../src/experience/genui/index.js';
import { renderScene, sceneKey, HINTS } from './scenes.js';
import { cartTotals, cartIsEmpty } from './reducer.js';

const TABS = [
  ['devices', 'Phones'], ['accessories', 'Accessories'], ['plans', 'Plans'], ['tradein', 'Trade-in'], ['cart', 'Cart'],
];
const TAB_FOR = { device: 'devices', compare: 'devices', done: 'cart' };

/**
 * @param {{store:ReturnType<typeof import('./store.js').createStore>, tap:(a:object)=>void, ask:(q:string)=>void}} deps
 */
export function createPanel({ store, tap, ask }) {
  const host = h('div', { class: 'scene-host', 'data-testid': 'scene-host' });
  const suggest = h('div', { class: 'suggest', 'data-testid': 'suggest' });
  const hint = h('p', { class: 'hint', 'data-testid': 'hint' });
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
  const el = h('main', { class: 'panel', id: 'panel' }, nav, host, suggest, hint);
  let lastKey = '';
  let hintTimer = 0;
  let hintIndex = 0;
  let hintScene = '';

  function renderNav(state) {
    clear(nav);
    const active = TAB_FOR[state.scene] || state.scene;
    for (const [scene, label] of TABS) {
      const count = scene === 'cart' && !cartIsEmpty(state.cart) ? usd(cartTotals(state.cart).today) : null;
      nav.append(h('button', {
        type: 'button', class: 'tab', 'data-testid': `tab-${scene}`, 'data-key': `tab-${scene}`,
        'aria-current': active === scene ? 'page' : null, onclick: () => tap({ type: 'show', scene }),
      }, label, count ? h('span', { class: 'tab-badge' }, count) : null));
    }
    nav.hidden = state.scene === 'welcome';
  }

  function showHint(state) {
    const list = HINTS[state.scene] || [];
    if (hintScene !== state.scene) { hintScene = state.scene; hintIndex = 0; }
    hint.textContent = list.length ? `Try saying: “${list[hintIndex % list.length]}”` : '';
    hint.hidden = !list.length;
  }

  // The agent's suggested questions use the SDK's own followups widget.
  let chipsKey = '';
  function showChips(state) {
    const key = state.suggestions.join('|');
    if (key === chipsKey) return;
    chipsKey = key;
    clear(suggest);
    if (state.suggestions.length) mountWidget({ kind: 'followups', data: { title: 'Ask me next', questions: state.suggestions } }, suggest, { onAction: (a, p) => { if (a === 'followup') ask(p.question); } });
  }

  function render(state) {
    const focusKey = host.contains(document.activeElement) || nav.contains(document.activeElement)
      ? document.activeElement?.getAttribute('data-key') : null;
    const key = sceneKey(state);
    const changed = key !== lastKey;
    lastKey = key;
    renderNav(state);
    clear(host);
    const node = renderScene(state, tap);
    if (changed) node.classList.add('enter');
    host.append(node);
    host.dataset.scene = state.scene;
    showHint(state);
    showChips(state);
    if (focusKey) el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    else if (changed) { host.tabIndex = -1; host.focus({ preventScroll: true }); }
  }

  render(store.getState());
  store.subscribe((next) => render(next));
  hintTimer = setInterval(() => { hintIndex++; showHint(store.getState()); }, 7000);

  return { el, destroy() { clearInterval(hintTimer); el.remove(); } };
}

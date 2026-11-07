/**
 * Scenes: one function per screen. Each takes the state and a `tap(action)`
 * callback and returns an element. A tap dispatches the same action a voice
 * tool call does, so touch and voice cannot drift apart.
 */
import { h, usd } from './dom.js';
import {
  DEVICES, ACCESSORIES, PLANS, TRADE_IN_MODELS, TRADE_IN_CONDITIONS,
  deviceById, accessoryById, planById,
} from './catalog.js';
import { cartTotals, cartIsEmpty, devicePrice, tradeInValue } from './reducer.js';

/** Voice hints shown under each scene. They teach the hands-free path. */
export const HINTS = {
  welcome: ['Show me your phones', 'What plans do you have?', 'What is my old phone worth?'],
  devices: ['Tell me about the Flip', 'Compare the One and the Lite', 'Which one has the best battery?'],
  device: ['Make it Ember', 'Go for 256 gigabytes', 'Add it to my cart'],
  compare: ['Which is better for photos?', 'I will take the Lite', 'Go back'],
  accessories: ['Add the rugged case', 'Do you have earbuds?', 'Show me my cart'],
  plans: ['Pick the Plus plan', 'What does Max add?', 'Show me my cart'],
  tradein: ['I have an older Orbit in good shape', 'Put that toward my phone', 'Show me my cart'],
  cart: ['Place my order', 'Remove the charger', 'Add a plan'],
  done: ['Thanks, Juno!', 'Start over'],
};

/** A phone drawn in CSS. @param {import('./catalog.js').Device} d @param {string} hex @param {string} [size] */
export function phoneArt(d, hex, size = 'md') {
  const body = h('div', { class: `phone phone-${d.form} phone-${size}`, style: { '--body': hex }, role: 'img', 'aria-label': `${d.name} in color` },
    h('div', { class: 'phone-screen' }, h('i', { class: 'phone-glow' }), h('b', { class: 'phone-clock' }, '9:41')),
    d.form === 'flip' ? h('div', { class: 'phone-hinge' }) : null,
    h('div', { class: 'phone-cam' }, h('i'), h('i'), d.form === 'bar' ? h('i') : null));
  return body;
}

const btn = (label, onclick, { kind = 'ghost', testid, pressed, disabled, key } = {}) =>
  h('button', { type: 'button', class: `btn btn-${kind}`, onclick, 'data-testid': testid, 'data-key': key ?? testid, 'aria-pressed': pressed == null ? null : String(pressed), disabled: disabled || null }, label);

const title = (text, sub) => h('header', { class: 'scene-head' }, h('h1', null, text), sub ? h('p', null, sub) : null);

function welcome(_s, tap) {
  return h('section', { class: 'scene scene-welcome' },
    h('div', { class: 'hello' }, h('span', { class: 'eyebrow' }, 'Gizmo Grove'), h('h1', null, 'Hi, I’m Juno.'),
      h('p', null, 'Ask me anything out loud, or tap. Either way works.')),
    h('div', { class: 'big-actions' },
      btn('Browse phones', () => tap({ type: 'show', scene: 'devices' }), { kind: 'primary', testid: 'go-devices' }),
      btn('Trade in my phone', () => tap({ type: 'show', scene: 'tradein' }), { testid: 'go-tradein' }),
      btn('See plans', () => tap({ type: 'show', scene: 'plans' }), { testid: 'go-plans' })));
}

function devices(_s, tap) {
  return h('section', { class: 'scene scene-devices' }, title('Our phones', 'Tap one, or tell me which.'),
    h('div', { class: 'cards cards-3' }, DEVICES.map((d) =>
      h('button', { type: 'button', class: 'card card-device', 'data-testid': `device-${d.id}`, 'data-key': `device-${d.id}`, onclick: () => tap({ type: 'show', scene: 'device', deviceId: d.id }) },
        phoneArt(d, d.colors[0].hex, 'sm'), h('strong', null, d.name), h('span', { class: 'muted' }, d.tagline), h('span', { class: 'price' }, `From ${usd(d.price)}`)))));
}

function device(s, tap) {
  const d = deviceById(s.deviceId);
  const color = d.colors.find((c) => c.id === s.colorId) || d.colors[0];
  const inCart = s.cart.device?.id === d.id;
  return h('section', { class: 'scene scene-device' },
    h('div', { class: 'stage-phone' }, phoneArt(d, color.hex, 'lg')),
    h('div', { class: 'detail' },
      h('h1', null, d.name), h('p', { class: 'muted' }, d.tagline),
      h('div', { class: 'opt-group', role: 'group', 'aria-label': 'Color' }, h('span', { class: 'opt-label' }, `Color: ${color.name}`),
        h('div', { class: 'swatches' }, d.colors.map((c) =>
          h('button', { type: 'button', class: 'swatch', style: { '--sw': c.hex }, 'aria-label': c.name, 'aria-pressed': String(c.id === color.id), 'data-testid': `color-${c.id}`, 'data-key': `color-${c.id}`, onclick: () => tap({ type: 'choose-option', kind: 'color', value: c.id }) })))),
      h('div', { class: 'opt-group', role: 'group', 'aria-label': 'Storage' }, h('span', { class: 'opt-label' }, 'Storage'),
        h('div', { class: 'segments' }, d.storage.map((o) =>
          btn(`${o.gb} GB`, () => tap({ type: 'choose-option', kind: 'storage', value: o.gb }), { pressed: o.gb === s.storageGb, testid: `storage-${o.gb}` })))),
      h('ul', { class: 'bullets' }, d.highlights.map((t) => h('li', null, t))),
      h('div', { class: 'buy-row' },
        h('span', { class: 'price price-lg', 'data-testid': 'device-price' }, usd(devicePrice({ id: d.id, storageGb: s.storageGb }))),
        btn(inCart ? 'In your cart' : 'Add to cart', () => tap({ type: 'add-device' }), { kind: 'primary', testid: 'add-device', disabled: inCart }),
        btn('Compare', () => tap({ type: 'show', scene: 'compare', deviceIds: DEVICES.map((x) => x.id) }), { testid: 'go-compare' }))));
}

function compare(s, tap) {
  const list = s.compareIds.map(deviceById);
  return h('section', { class: 'scene scene-compare' }, title('Side by side'),
    h('div', { class: 'cards', style: { '--cols': list.length } }, list.map((d) =>
      h('div', { class: 'card card-compare', 'data-testid': `compare-${d.id}` },
        phoneArt(d, d.colors[0].hex, 'sm'), h('strong', null, d.name), h('span', { class: 'price' }, `From ${usd(d.price)}`),
        h('ul', { class: 'bullets' }, d.highlights.map((t) => h('li', null, t))),
        btn('Choose', () => tap({ type: 'show', scene: 'device', deviceId: d.id }), { kind: 'primary', testid: `choose-${d.id}` })))));
}

function accessories(s, tap) {
  return h('section', { class: 'scene scene-accessories' }, title('Accessories', 'Add what you need.'),
    h('div', { class: 'cards cards-3' }, ACCESSORIES.map((a) => {
      const q = s.cart.accessories[a.id] || 0;
      return h('div', { class: 'card card-acc', 'data-testid': `acc-${a.id}` },
        h('div', { class: `acc-art acc-${a.kind}`, 'aria-hidden': 'true' }, q ? h('span', { class: 'qty' }, `×${q}`) : null),
        h('strong', null, a.name), h('span', { class: 'muted' }, a.note), h('span', { class: 'price' }, usd(a.price)),
        btn(q ? 'Add another' : 'Add', () => tap({ type: 'add-accessory', id: a.id }), { kind: q ? 'ghost' : 'primary', testid: `add-${a.id}` }));
    })));
}

function plans(s, tap) {
  return h('section', { class: 'scene scene-plans' }, title('Plans', 'Pick the one that fits.'),
    h('div', { class: 'cards cards-3' }, PLANS.map((p) => {
      const on = s.cart.planId === p.id;
      return h('div', { class: `card card-plan${on ? ' is-on' : ''}`, 'data-testid': `plan-${p.id}` },
        h('strong', null, p.name), h('span', { class: 'price price-lg' }, `${usd(p.price)}`, h('small', null, ' / month')), h('span', { class: 'muted' }, `${p.data} data`),
        h('ul', { class: 'bullets' }, p.perks.map((t) => h('li', null, t))),
        btn(on ? 'Chosen' : 'Choose', () => tap({ type: 'set-plan', id: p.id }), { kind: on ? 'ghost' : 'primary', testid: `pick-${p.id}`, pressed: on }));
    })));
}

function tradein(s, tap) {
  const cur = s.cart.tradeIn;
  const model = cur?.modelId ?? 'old-orbit';
  const cond = cur?.condition ?? 'good';
  const pick = (m, c) => () => tap({ type: 'set-trade-in', modelId: m, condition: c });
  return h('section', { class: 'scene scene-tradein' }, title('Trade in', 'Tell me about your old phone.'),
    h('div', { class: 'opt-group', role: 'group', 'aria-label': 'Old phone' }, h('span', { class: 'opt-label' }, 'Your phone'),
      h('div', { class: 'segments' }, TRADE_IN_MODELS.map((m) => btn(m.name, pick(m.id, cond), { pressed: cur ? m.id === model : false, testid: `ti-model-${m.id}` })))),
    h('div', { class: 'opt-group', role: 'group', 'aria-label': 'Condition' }, h('span', { class: 'opt-label' }, 'Condition'),
      h('div', { class: 'segments' }, TRADE_IN_CONDITIONS.map((c) => btn(c.name, pick(model, c.id), { pressed: cur ? c.id === cond : false, testid: `ti-cond-${c.id}` })))),
    h('div', { class: 'estimate', 'data-testid': 'estimate' },
      cur ? [h('span', { class: 'muted' }, 'Estimated credit'), h('strong', { class: 'price price-xl' }, usd(cur.value ?? tradeInValue(model, cond)))]
        : h('span', { class: 'muted' }, 'Pick a phone and a condition to see your credit.')),
    cur ? btn('Remove trade-in', () => tap({ type: 'clear-trade-in' }), { testid: 'clear-tradein' }) : null);
}

function cart(s, tap) {
  const c = s.cart;
  if (cartIsEmpty(c) && !c.tradeIn) {
    return h('section', { class: 'scene scene-cart' }, title('Your cart'), h('p', { class: 'muted' }, 'Nothing here yet.'),
      btn('Browse phones', () => tap({ type: 'show', scene: 'devices' }), { kind: 'primary', testid: 'go-devices' }));
  }
  const t = cartTotals(c);
  const line = (label, price, onRemove, key, note) => h('li', { class: 'line', 'data-testid': `line-${key}` },
    h('div', null, h('strong', null, label), note ? h('span', { class: 'muted' }, note) : null),
    h('span', { class: 'price' }, price),
    btn('Remove', onRemove, { testid: `remove-${key}`, kind: 'quiet' }));
  const d = c.device && deviceById(c.device.id);
  return h('section', { class: 'scene scene-cart' }, title('Your cart'),
    h('ul', { class: 'lines' },
      d ? line(d.name, usd(devicePrice(c.device)), () => tap({ type: 'remove-device' }), 'device', `${d.colors.find((x) => x.id === c.device.colorId).name}, ${c.device.storageGb} GB`) : null,
      Object.entries(c.accessories).map(([id, q]) => line(`${accessoryById(id).name}${q > 1 ? ` ×${q}` : ''}`, usd(accessoryById(id).price * q), () => tap({ type: 'remove-accessory', id }), id)),
      c.planId ? line(`${planById(c.planId).name} plan`, `${usd(planById(c.planId).price)}/mo`, () => tap({ type: 'clear-plan' }), 'plan') : null,
      c.tradeIn ? line('Trade-in credit', `−${usd(t.tradeIn)}`, () => tap({ type: 'clear-trade-in' }), 'tradein') : null),
    h('div', { class: 'totals' },
      h('div', null, h('span', null, 'Due today'), h('strong', { 'data-testid': 'total-today', class: 'price price-xl' }, usd(t.today))),
      t.monthly ? h('div', { class: 'muted' }, `then ${usd(t.monthly)} per month`) : null),
    h('div', { class: 'buy-row' },
      btn('Place order', () => tap({ type: 'place-order' }), { kind: 'primary', testid: 'place-order', disabled: cartIsEmpty(c) }),
      btn('Keep shopping', () => tap({ type: 'show', scene: 'devices' }), { testid: 'go-devices' })));
}

function done(s, tap) {
  return h('section', { class: 'scene scene-done' },
    h('div', { class: 'check', 'aria-hidden': 'true' }), h('h1', null, 'Order placed!'),
    h('p', null, 'Your order number is ', h('strong', { 'data-testid': 'order-number' }, s.order?.number)),
    h('p', { class: 'muted' }, 'You will get an email with pickup details.'),
    btn('Start over', () => tap({ type: 'reset' }), { kind: 'primary', testid: 'reset' }));
}

const SCENES = { welcome, devices, device, compare, accessories, plans, tradein, cart, done };

/** @param {import('./reducer.js').State} state @param {(a:object)=>void} tap */
export function renderScene(state, tap) {
  return (SCENES[state.scene] || welcome)(state, tap);
}

/** Key that changes when the screen changes, not when a choice inside it does. @param {import('./reducer.js').State} s */
export const sceneKey = (s) => `${s.scene}:${s.scene === 'device' ? s.deviceId : s.scene === 'compare' ? s.compareIds.join('+') : ''}`;

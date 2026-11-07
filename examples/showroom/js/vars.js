/**
 * Plain-text views of the app state. They go to the agent as request variables
 * (`screen`, `cart`), so it always knows what the customer sees and has chosen.
 */
import { deviceById, accessoryById, planById, TRADE_IN_MODELS, TRADE_IN_CONDITIONS } from './catalog.js';
import { cartTotals, cartIsEmpty, devicePrice } from './reducer.js';

const usd = (n) => `$${n}`;

/** @param {import('./reducer.js').State} s */
export function screenText(s) {
  switch (s.scene) {
    case 'welcome': return 'The welcome screen. Nothing is selected yet.';
    case 'devices': return `The phone list: ${['orbit-one', 'orbit-flip', 'orbit-lite'].map((id) => deviceById(id).name).join(', ')}.`;
    case 'device': {
      const d = deviceById(s.deviceId);
      const color = d.colors.find((c) => c.id === s.colorId);
      return `The ${d.name} page. Selected color: ${color.name}. Selected storage: ${s.storageGb} GB. Price with this storage: ${usd(devicePrice({ id: d.id, storageGb: s.storageGb }))}.`;
    }
    case 'compare': return `A side-by-side comparison of ${s.compareIds.map((id) => deviceById(id).name).join(' and ')}.`;
    case 'accessories': return 'The accessories list: cases, earbuds, charger, screen guard.';
    case 'plans': return `The plans list. Chosen plan: ${s.cart.planId ? planById(s.cart.planId).name : 'none'}.`;
    case 'tradein': return s.cart.tradeIn ? `The trade-in screen. Estimate: ${usd(s.cart.tradeIn.value)}.` : 'The trade-in screen. No estimate yet.';
    case 'cart': return 'The cart with the total.';
    case 'done': return `The order confirmation. Order number ${s.order?.number}.`;
    default: return 'Unknown screen.';
  }
}

/** @param {import('./reducer.js').Cart} cart */
export function cartText(cart) {
  if (cartIsEmpty(cart)) return 'The cart is empty.';
  const parts = [];
  if (cart.device) {
    const d = deviceById(cart.device.id);
    parts.push(`${d.name}, ${d.colors.find((c) => c.id === cart.device.colorId).name}, ${cart.device.storageGb} GB, ${usd(devicePrice(cart.device))}`);
  }
  for (const [id, q] of Object.entries(cart.accessories)) parts.push(`${accessoryById(id).name} x${q}, ${usd(accessoryById(id).price * q)}`);
  if (cart.planId) parts.push(`Plan ${planById(cart.planId).name}, ${usd(planById(cart.planId).price)} per month`);
  if (cart.tradeIn) {
    const m = TRADE_IN_MODELS.find((x) => x.id === cart.tradeIn.modelId);
    const c = TRADE_IN_CONDITIONS.find((x) => x.id === cart.tradeIn.condition);
    parts.push(`Trade-in: ${m.name}, ${c.name}, credit ${usd(cart.tradeIn.value)}`);
  }
  const t = cartTotals(cart);
  return `${parts.join('; ')}. Due today ${usd(t.today)}${t.monthly ? `, then ${usd(t.monthly)} per month` : ''}.`;
}

/**
 * Notes sent to the agent when the customer taps instead of speaking. Only
 * meaningful taps get a note, so the agent reacts to a choice and not to scrolling.
 * @param {import('./reducer.js').State} prev
 * @param {import('./reducer.js').State} next
 * @param {{type:string,[k:string]:any}} action
 * @returns {string|null}
 */
export function tapNote(prev, next, action) {
  switch (action.type) {
    case 'show':
      if (next.scene === 'device') return `[The customer tapped ${deviceById(next.deviceId).name}.]`;
      if (next.scene === 'plans') return '[The customer opened the plans.]';
      if (next.scene === 'accessories') return '[The customer opened accessories.]';
      if (next.scene === 'cart') return '[The customer opened the cart.]';
      if (next.scene === 'devices' && prev.scene !== 'welcome') return '[The customer went back to the phone list.]';
      return null;
    case 'choose-option': {
      const d = deviceById(next.deviceId);
      return action.kind === 'color'
        ? `[The customer picked the color ${d.colors.find((c) => c.id === action.value).name}.]`
        : `[The customer picked ${action.value} GB.]`;
    }
    case 'add-device': return `[The customer added the ${deviceById(next.cart.device.id).name} to the cart.]`;
    case 'add-accessory': return `[The customer added ${accessoryById(action.id).name} to the cart.]`;
    case 'set-plan': return `[The customer chose the ${planById(action.id).name} plan.]`;
    case 'set-trade-in': return `[The customer got a trade-in estimate of ${usd(next.cart.tradeIn.value)}.]`;
    case 'remove-device': case 'remove-accessory': case 'clear-plan': case 'clear-trade-in': return '[The customer removed something from the cart.]';
    case 'place-order': return next.order ? `[The customer placed order ${next.order.number}.]` : null;
    default: return null;
  }
}
